package com.codepilot.repository;

import com.codepilot.model.AgentRun;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public interface AgentRunRepository extends JpaRepository<AgentRun, UUID> {
    List<AgentRun> findByProjectIdOrderByStartedAtDesc(UUID projectId, Pageable pageable);
    List<AgentRun> findByStatus(String status);
}
