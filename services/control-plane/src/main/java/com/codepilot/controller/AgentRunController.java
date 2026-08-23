package com.codepilot.controller;

import com.codepilot.model.AgentRun;
import com.codepilot.repository.AgentRunRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/agent-runs")
public class AgentRunController {

    private final AgentRunRepository agentRunRepository;

    public AgentRunController(AgentRunRepository agentRunRepository) {
        this.agentRunRepository = agentRunRepository;
    }

    @GetMapping
    public ResponseEntity<List<AgentRun>> listRuns(
            @RequestParam(required = false) UUID projectId,
            @RequestParam(defaultValue = "20") int limit) {
        if (projectId != null) {
            return ResponseEntity.ok(
                    agentRunRepository.findByProjectIdOrderByStartedAtDesc(projectId, 
                            org.springframework.data.domain.PageRequest.of(0, limit)));
        }
        return ResponseEntity.ok(
                agentRunRepository.findAll(org.springframework.data.domain.PageRequest.of(0, limit))
                        .getContent());
    }

    @GetMapping("/{id}")
    public ResponseEntity<AgentRun> getRun(@PathVariable UUID id) {
        return agentRunRepository.findById(id)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<AgentRun> createRun(@RequestBody AgentRun run) {
        AgentRun saved = agentRunRepository.save(run);
        return ResponseEntity.status(org.springframework.http.HttpStatus.CREATED).body(saved);
    }

    @PatchMapping("/{id}")
    public ResponseEntity<AgentRun> updateRun(@PathVariable UUID id, @RequestBody AgentRun updates) {
        return agentRunRepository.findById(id)
                .map(existing -> {
                    if (updates.getStatus() != null) existing.setStatus(updates.getStatus());
                    if (updates.getResult() != null) existing.setResult(updates.getResult());
                    if (updates.getDurationMs() != null) existing.setDurationMs(updates.getDurationMs());
                    if (updates.getInputTokens() != null) existing.setInputTokens(updates.getInputTokens());
                    if (updates.getOutputTokens() != null) existing.setOutputTokens(updates.getOutputTokens());
                    if (updates.getTotalCost() != null) existing.setTotalCost(updates.getTotalCost());
                    if (updates.getFilesChanged() != null) existing.setFilesChanged(updates.getFilesChanged());
                    if (updates.getTestsRun() != null) existing.setTestsRun(updates.getTestsRun());
                    if (updates.getTestsPassed() != null) existing.setTestsPassed(updates.getTestsPassed());
                    if (updates.getTestsFailed() != null) existing.setTestsFailed(updates.getTestsFailed());
                    if (updates.getCompletedAt() != null) existing.setCompletedAt(updates.getCompletedAt());
                    return ResponseEntity.ok(agentRunRepository.save(existing));
                })
                .orElse(ResponseEntity.notFound().build());
    }
}
