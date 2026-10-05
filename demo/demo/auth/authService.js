const bcrypt = require("bcryptjs");
const userRepository = require("../database/userRepository");

const BCRYPT_ROUNDS = 10;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_SIGNUP = "Please provide a valid username, email, and password.";
const INVALID_LOGIN = "Invalid username or password.";

const dummyPasswordHash = bcrypt.hashSync("metricmantis-dummy-password", BCRYPT_ROUNDS);

class AuthError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function toPublicUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
  };
}

function validateSignup(input) {
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";

  if (
    !username ||
    username.length > 64 ||
    !EMAIL_PATTERN.test(email) ||
    email.length > 254 ||
    password.length < 8 ||
    password.length > 128
  ) {
    return null;
  }

  return { username, email, password };
}

async function signup(input) {
  const fields = validateSignup(input || {});
  if (!fields) {
    throw new AuthError(INVALID_SIGNUP, 400);
  }

  if (userRepository.findByUsername(fields.username)) {
    throw new AuthError("Username already exists.", 409);
  }

  if (userRepository.findByEmail(fields.email)) {
    throw new AuthError("Email already registered.", 409);
  }

  const passwordHash = await bcrypt.hash(fields.password, BCRYPT_ROUNDS);

  try {
    const user = userRepository.createUser({
      username: fields.username,
      email: fields.email,
      passwordHash,
    });
    return toPublicUser(user);
  } catch (error) {
    if (isUniqueConstraint(error)) {
      if (userRepository.findByUsername(fields.username)) {
        throw new AuthError("Username already exists.", 409);
      }
      throw new AuthError("Email already registered.", 409);
    }
    throw error;
  }
}

async function login(input) {
  const username = typeof input?.username === "string" ? input.username.trim() : "";
  const password = typeof input?.password === "string" ? input.password : "";

  const user = username ? userRepository.findByUsername(username) : null;
  const hash = user ? user.password_hash : dummyPasswordHash;
  const matches = await bcrypt.compare(password, hash);

  if (!user || !password || !matches) {
    throw new AuthError(INVALID_LOGIN, 401);
  }

  return toPublicUser(user);
}

function getUserById(id) {
  if (!id) return null;
  const user = userRepository.findById(id);
  return user ? toPublicUser(user) : null;
}

function isUniqueConstraint(error) {
  return (
    error &&
    (error.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      error.code === "SQLITE_CONSTRAINT")
  );
}

module.exports = {
  AuthError,
  signup,
  login,
  getUserById,
};
