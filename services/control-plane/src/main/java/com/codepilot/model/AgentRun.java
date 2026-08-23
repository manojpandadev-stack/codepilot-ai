package com.codepilot.model;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "agent_runs")
public class AgentRun {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "project_id", nullable = false)
    private Project project;

    @Column(nullable = false)
    private String sessionId;

    private String mode;

    private String provider;

    private String model;

    private String privacyMode;

    private String status;

    @Column(columnDefinition = "TEXT")
    private String prompt;

    @Column(columnDefinition = "TEXT")
    private String result;

    private Long durationMs;

    private Long inputTokens;

    private Long outputTokens;

    private Double totalCost;

    private Integer filesChanged;

    private Integer testsRun;

    private Integer testsPassed;

    private Integer testsFailed;

    @Column(nullable = false)
    private Instant startedAt;

    private Instant completedAt;

    @PrePersist
    protected void onCreate() {
        startedAt = Instant.now();
    }

    // Getters and setters
    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public Project getProject() { return project; }
    public void setProject(Project project) { this.project = project; }
    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }
    public String getMode() { return mode; }
    public void setMode(String mode) { this.mode = mode; }
    public String getProvider() { return provider; }
    public void setProvider(String provider) { this.provider = provider; }
    public String getModel() { return model; }
    public void setModel(String model) { this.model = model; }
    public String getPrivacyMode() { return privacyMode; }
    public void setPrivacyMode(String privacyMode) { this.privacyMode = privacyMode; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public String getPrompt() { return prompt; }
    public void setPrompt(String prompt) { this.prompt = prompt; }
    public String getResult() { return result; }
    public void setResult(String result) { this.result = result; }
    public Long getDurationMs() { return durationMs; }
    public void setDurationMs(Long durationMs) { this.durationMs = durationMs; }
    public Long getInputTokens() { return inputTokens; }
    public void setInputTokens(Long inputTokens) { this.inputTokens = inputTokens; }
    public Long getOutputTokens() { return outputTokens; }
    public void setOutputTokens(Long outputTokens) { this.outputTokens = outputTokens; }
    public Double getTotalCost() { return totalCost; }
    public void setTotalCost(Double totalCost) { this.totalCost = totalCost; }
    public Integer getFilesChanged() { return filesChanged; }
    public void setFilesChanged(Integer filesChanged) { this.filesChanged = filesChanged; }
    public Integer getTestsRun() { return testsRun; }
    public void setTestsRun(Integer testsRun) { this.testsRun = testsRun; }
    public Integer getTestsPassed() { return testsPassed; }
    public void setTestsPassed(Integer testsPassed) { this.testsPassed = testsPassed; }
    public Integer getTestsFailed() { return testsFailed; }
    public void setTestsFailed(Integer testsFailed) { this.testsFailed = testsFailed; }
    public Instant getStartedAt() { return startedAt; }
    public Instant getCompletedAt() { return completedAt; }
    public void setCompletedAt(Instant completedAt) { this.completedAt = completedAt; }
}
