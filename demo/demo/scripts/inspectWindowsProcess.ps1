# inspectWindowsProcess.ps1
#
# Reads the command line, current working directory, and environment block of a
# Windows process by walking its Process Environment Block (PEB). The PEB is read
# cross-process with the standard PROCESS_QUERY_INFORMATION | PROCESS_VM_READ
# access, which the owner of a process (or an administrator) is granted, so this
# works for this project's own API without elevation.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File inspectWindowsProcess.ps1 -ProcessId <pid>
#
# Stdout: a single compact JSON object, one of:
#   {"command":"...","cwd":"...","environment":"..."}   all strings (environment may be "")
#   {}                                                   the process could not be inspected safely
#
# Any failure (unknown PID, access denied, unsupported bitness, etc.) produces "{}" so the
# caller fails safe with an "unknown" listener state rather than acting on partial data.

param([Parameter(Mandatory = $true)][int]$ProcessId)

$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PEBReader
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    // PROCESS_QUERY_INFORMATION (0x0400) | PROCESS_VM_READ (0x0010)
    private const uint ProcessAccess = 0x0410;

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr h, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);

    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr h, int infoClass, IntPtr info, int infoLen, out int returnLength);

    // Offsets within the PEB / RTL_USER_PROCESS_PARAMETERS. These are stable across
    // modern Windows versions (7+). They differ for 64-bit vs 32-bit processes.
    static int ProcessParametersOffset { get { return IntPtr.Size == 8 ? 0x20 : 0x10; } }
    static int CurrentDirectoryOffset { get { return IntPtr.Size == 8 ? 0x38 : 0x24; } }
    static int CommandLineOffset      { get { return IntPtr.Size == 8 ? 0x70 : 0x40; } }

    static long ReadPointer(IntPtr h, IntPtr address)
    {
        byte[] b = new byte[IntPtr.Size];
        IntPtr read;
        if (!ReadProcessMemory(h, address, b, (IntPtr)IntPtr.Size, out read) || read.ToInt64() != IntPtr.Size)
            return 0;
        return IntPtr.Size == 8 ? BitConverter.ToInt64(b, 0) : (long)BitConverter.ToInt32(b, 0);
    }

    // Reads a UNICODE_STRING { USHORT Length; USHORT MaximumLength; [pad] PWSTR Buffer }.
    static string ReadUnicodeString(IntPtr h, IntPtr processParameters, int offset)
    {
        int headerSize = IntPtr.Size == 8 ? 16 : 8;
        byte[] head = new byte[headerSize];
        IntPtr read;
        if (!ReadProcessMemory(h, processParameters + offset, head, (IntPtr)headerSize, out read) || read.ToInt64() != headerSize)
            return null;
        short length = (short)(head[0] | (head[1] << 8));
        long buffer = IntPtr.Size == 8 ? BitConverter.ToInt64(head, 8) : (long)BitConverter.ToInt32(head, 4);
        if (length <= 0 || buffer == 0) return "";
        byte[] chars = new byte[length];
        if (!ReadProcessMemory(h, (IntPtr)buffer, chars, (IntPtr)length, out read) || read.ToInt64() != length)
            return null;
        return Encoding.Unicode.GetString(chars, 0, length).TrimEnd('\0');
    }

    // The Environment pointer offset varies across Windows builds (seen at 0x80 on
    // modern x64). Rather than hardcode a single offset, read the ProcessParameters
    // struct once and probe a few candidate offsets, accepting the first whose target
    // decodes to a real environment block. This stays correct across versions and
    // fails safe (returns null) when nothing looks like an environment.
    static string ReadEnvironment(IntPtr h, IntPtr processParameters)
    {
        byte[] region = new byte[0xD8];
        IntPtr regionRead;
        if (!ReadProcessMemory(h, processParameters, region, (IntPtr)region.Length, out regionRead))
            return null;

        int[] candidateOffsets = IntPtr.Size == 8
            ? new int[] { 0x80, 0xC0, 0x88, 0xB8, 0xA0 }
            : new int[] { 0x48, 0x68, 0x44, 0x60, 0x58 };

        foreach (int offset in candidateOffsets)
        {
            long envAddress = IntPtr.Size == 8
                ? BitConverter.ToInt64(region, offset)
                : (long)BitConverter.ToInt32(region, offset);
            if (envAddress == 0) continue;

            byte[] block = new byte[0x10000];
            IntPtr read;
            ReadProcessMemory(h, (IntPtr)envAddress, block, (IntPtr)block.Length, out read); // partial reads are fine
            int n = (int)read;
            if (n <= 1) continue;
            string full = Encoding.Unicode.GetString(block, 0, n);
            if (!LooksLikeEnvironment(full)) continue;

            string[] entries = full.Split('\0');
            StringBuilder sb = new StringBuilder();
            int count = 0;
            foreach (string entry in entries)
            {
                if (entry.Length == 0) break; // terminating empty entry
                if (sb.Length > 0) sb.Append('\n');
                sb.Append(entry);
                count++;
            }
            if (count < 5) continue; // a real environment has many entries
            return sb.ToString();
        }
        return null;
    }

    static bool LooksLikeEnvironment(string s)
    {
        return s != null && (
            s.Contains("SystemRoot=") || s.Contains("PATH=") || s.Contains("Path=") ||
            s.Contains("USERNAME=") || s.Contains("USERPROFILE=") || s.Contains("windir=") ||
            s.Contains("ProgramData=") || s.Contains("PATHEXT=") ||
            s.Contains("COMPUTERNAME=") || s.Contains("TEMP=") || s.Contains("OS="));
    }

    public static string[] ReadAll(int pid)
    {
        IntPtr h = OpenProcess(ProcessAccess, false, pid); // PROCESS_QUERY_INFORMATION | PROCESS_VM_READ
        if (h == IntPtr.Zero) return null;
        try
        {
            // PROCESS_BASIC_INFORMATION: ExitStatus; PebBaseAddress; AffinityMask; BasePriority; UniqueProcessId; Reserved3
            int pbiSize = IntPtr.Size * 6;
            IntPtr pbi = Marshal.AllocHGlobal(pbiSize);
            try
            {
                int returnLength;
                if (NtQueryInformationProcess(h, 0, pbi, pbiSize, out returnLength) != 0) return null;
                IntPtr peb = Marshal.ReadIntPtr(pbi, IntPtr.Size); // PebBaseAddress follows ExitStatus
                if (peb == IntPtr.Zero) return null;
                long processParameters = ReadPointer(h, peb + ProcessParametersOffset);
                if (processParameters == 0) return null;
                string command = ReadUnicodeString(h, (IntPtr)processParameters, CommandLineOffset);
                string cwd = ReadUnicodeString(h, (IntPtr)processParameters, CurrentDirectoryOffset);
                string env = ReadEnvironment(h, (IntPtr)processParameters);
                return new string[] { command, cwd, env };
            }
            finally
            {
                Marshal.FreeHGlobal(pbi);
            }
        }
        finally
        {
            CloseHandle(h);
        }
    }
}
'@

try
{
    Add-Type -TypeDefinition $src
}
catch
{
    # Add-Type can fail if the type was already defined in this runspace; ignore that case.
    if (-not ('PEBReader' -as [type]))
    {
        [Console]::Out.Write('{}')
        return
    }
}

$result = [PEBReader]::ReadAll($ProcessId)
if ($null -eq $result)
{
    [Console]::Out.Write('{}')
    return
}

$obj = [ordered]@{
    command     = $result[0]
    cwd         = $result[1]
    environment = $result[2]
}
[Console]::Out.Write(($obj | ConvertTo-Json -Depth 6 -Compress))
