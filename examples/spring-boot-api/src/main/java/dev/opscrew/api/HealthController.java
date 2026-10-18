package dev.opscrew.api;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** The routes OpsCrew's builder examples check. */
@RestController
public class HealthController {

	@GetMapping("/health")
	public Map<String, String> health() {
		return Map.of("status", "ok");
	}

	@GetMapping("/")
	public Map<String, String> root() {
		return Map.of("message", "Hello from Spring Boot");
	}
}
