package com.example.demo;

import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.yaml.snakeyaml.Yaml;

import java.util.*;

@RestController
public class YamlController {

    // Service model
    static class ServiceInfo {

        public String name;
        public List<String> dependsOn;

        ServiceInfo(String name, List<String> dependsOn) {

            this.name = name;
            this.dependsOn = dependsOn;
        }
    }

    // Response model
    static class ComposeResponse {

        public List<ServiceInfo> services;
        public List<String> warnings;

        ComposeResponse(List<ServiceInfo> services,
                        List<String> warnings) {

            this.services = services;
            this.warnings = warnings;
        }
    }

    // Home API
    @GetMapping("/")
    public String home() {

        return "MetricMantis Running";
    }

    // Upload + Parse API
    @PostMapping("/upload")
    public ComposeResponse parseCompose(
            @RequestParam("file") MultipartFile file) {

        try {

            Yaml yaml = new Yaml();

            Map<String, Object> data =
                    yaml.load(file.getInputStream());

            @SuppressWarnings("unchecked")
            Map<String, Object> services =
                    (Map<String, Object>) data.get("services");

            List<ServiceInfo> serviceList =
                    new ArrayList<>();

            List<String> warnings =
                    new ArrayList<>();

            for (String serviceName : services.keySet()) {

                @SuppressWarnings("unchecked")
                Map<String, Object> details =
                        (Map<String, Object>)
                                services.get(serviceName);

                List<String> deps =
                        new ArrayList<>();

                // Extract dependencies

                if (details != null &&
                        details.containsKey("depends_on")) {

                    Object dependsOn =
                            details.get("depends_on");

                    if (dependsOn instanceof List) {

                        for (Object d :
                                (List<?>) dependsOn) {

                            deps.add(d.toString());
                        }
                    }
                }

                // VALIDATIONS

                if (details != null &&
                        !details.containsKey("restart")) {

                    warnings.add(serviceName +
                            " has no restart policy");
                }

                if (details != null &&
                        !details.containsKey("mem_limit")) {

                    warnings.add(serviceName +
                            " has no memory limits");
                }

                // Add service object

                serviceList.add(
                        new ServiceInfo(serviceName, deps)
                );
            }

            return new ComposeResponse(
                    serviceList,
                    warnings
            );

        } catch (Exception e) {

            return new ComposeResponse(
                    Collections.emptyList(),
                    List.of("Error parsing YAML")
            );
        }
    }
}