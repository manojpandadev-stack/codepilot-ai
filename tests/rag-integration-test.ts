/**
 * RAG Integration Test
 * Tests: RepositoryIndexer → PgVector → Ollama embeddings → semantic search
 *
 * Prerequisites:
 * - PostgreSQL running on port 5433 (docker compose up postgres)
 * - Ollama running on localhost:11434 with nomic-embed-text
 */

import { RepositoryIndexer, type IndexResult } from "../packages/rag-engine/src/repository-indexer.ts";
import { PgVectorStore } from "../packages/rag-engine/src/pgvector-store.ts";
import { generateEmbedding, checkEmbeddingService } from "../packages/rag-engine/src/embeddings.ts";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const PG_CONFIG = {
  host: "localhost",
  port: 5433,
  database: "codepilot",
  user: "codepilot",
  password: "codepilot",
};

const EMBEDDING_CONFIG = {
  baseUrl: "http://localhost:11434",
  model: "nomic-embed-text",
};

const PROJECT_ID = "test-rag-project";

async function createTestRepository(): Promise<string> {
  const dir = join(tmpdir(), "rag-test-repo");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "src/main/java/com/example"), { recursive: true });
  mkdirSync(join(dir, "src/main/java/com/example/config"), { recursive: true });
  mkdirSync(join(dir, "src/test/java/com/example"), { recursive: true });

  writeFileSync(
    join(dir, "src/main/java/com/example/config/SecurityConfig.java"),
    `package com.example.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/public/**").permitAll()
                .anyRequest().authenticated()
            )
            .oauth2Login(oauth2 -> oauth2
                .loginPage("/login")
                .defaultSuccessUrl("/dashboard")
            )
            .formLogin(form -> form
                .loginPage("/login")
                .permitAll()
            );
        return http.build();
    }
}`
  );

  writeFileSync(
    join(dir, "src/main/java/com/example/OrderController.java"),
    `package com.example;

import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping
    public List<Order> getAllOrders() {
        return orderService.findAll();
    }

    @PostMapping
    public Order createOrder(@RequestBody OrderRequest request) {
        return orderService.create(request);
    }

    @GetMapping("/{id}")
    public Order getOrder(@PathVariable Long id) {
        return orderService.findById(id);
    }
}`
  );

  writeFileSync(
    join(dir, "src/main/java/com/example/OrderService.java"),
    `package com.example;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.List;

@Service
@Transactional
public class OrderService {

    private final OrderRepository orderRepository;

    public OrderService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    public List<Order> findAll() {
        return orderRepository.findAll();
    }

    public Order findById(Long id) {
        return orderRepository.findById(id)
            .orElseThrow(() -> new OrderNotFoundException(id));
    }

    public Order create(OrderRequest request) {
        Order order = new Order();
        order.setProductName(request.getProductName());
        order.setQuantity(request.getQuantity());
        order.setPrice(request.getPrice());
        return orderRepository.save(order);
    }
}`
  );

  writeFileSync(
    join(dir, "src/main/java/com/example/OrderRepository.java"),
    `package com.example;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface OrderRepository extends JpaRepository<Order, Long> {
    List<Order> findByProductName(String productName);
}`
  );

  writeFileSync(join(dir, "pom.xml"), `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>order-service</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-security</artifactId>
    </dependency>
  </dependencies>
</project>`);

  return dir;
}

async function main(): Promise<void> {
  console.log("=== RAG Integration Test ===\n");

  // Check prerequisites
  console.log("1. Checking prerequisites...");
  const embeddingService = await checkEmbeddingService(EMBEDDING_CONFIG.baseUrl);
  console.log(`   Embedding service: ${embeddingService.available ? "✅ Available" : "❌ Not available"}`);
  if (!embeddingService.available) {
    console.error("   Ollama with nomic-embed-text required. Aborting.");
    process.exit(1);
  }

  // Create test repository
  console.log("\n2. Creating test Spring Boot repository...");
  const repoPath = await createTestRepository();
  console.log(`   Created at: ${repoPath}`);

  // Initialize indexer
  console.log("\n3. Initializing RAG indexer...");
  const indexer = new RepositoryIndexer({
    pgConfig: PG_CONFIG,
    embeddingConfig: EMBEDDING_CONFIG,
    chunkSize: 30,
  });
  await indexer.initialize();
  console.log("   ✅ PgVector store initialized");

  // Index repository
  console.log("\n4. Indexing repository...");
  const indexResult: IndexResult = await indexer.indexRepository(repoPath, PROJECT_ID, (msg) => {
    console.log(`   ${msg}`);
  });
  console.log(`\n   Index result:`);
  console.log(`   Files scanned: ${indexResult.filesScanned}`);
  console.log(`   Files indexed: ${indexResult.filesIndexed}`);
  console.log(`   Chunks created: ${indexResult.chunksCreated}`);
  console.log(`   Embeddings created: ${indexResult.embeddingsCreated}`);
  console.log(`   Errors: ${indexResult.errors.length}`);
  if (indexResult.errors.length > 0) {
    for (const e of indexResult.errors) console.log(`   ⚠️  ${e}`);
  }
  console.log(`   Duration: ${indexResult.durationMs}ms`);

  // Test queries
  const queries = [
    "Where is authentication configured?",
    "Where is order persistence implemented?",
    "Explain the order request flow",
  ];

  for (const query of queries) {
    console.log(`\n--- Query: "${query}" ---`);
    const results = await indexer.search(query, PROJECT_ID, { limit: 5 });
    if (results.length === 0) {
      console.log("   No results found.");
    } else {
      for (const r of results) {
        console.log(`   [${r.matchType}] ${r.filePath}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})`);
        const preview = r.content.split("\n").slice(0, 3).join("\n").substring(0, 120);
        console.log(`     ${preview.replace(/\n/g, "\n     ")}...`);
      }
    }
  }

  // Get stats
  const stats = await indexer.getStats(PROJECT_ID);
  console.log(`\n=== Results ===`);
  console.log(`Total chunks in index: ${stats.chunkCount}`);
  console.log(`\n✅ RAG integration test complete.`);

  // Cleanup
  await indexer.close();
  rmSync(repoPath, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
