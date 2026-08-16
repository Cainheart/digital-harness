import { describe, expect, it } from "vitest";
import { newObjectId, utcNow } from "../../src/domain/common.js";
import { ArtifactVersion } from "../../src/domain/entities.js";
import { EvidenceRepository } from "../../src/infra/repositories/evidence.js";
import { ProjectTaskRepository } from "../../src/infra/repositories/project-task.js";
import { TraceRepository } from "../../src/infra/repositories/trace.js";
import { createTestApp, makeProject, makeTask, useTestRoot } from "../helpers.js";

describe("Task 2 evidence and trace repositories", () => {
  it("stores content-addressed artifacts and detects tampering", async () => {
    const root = useTestRoot();
    const app = await createTestApp(root);
    const reference = await app.runtime.artifactStore.put(Buffer.from("hello"), "text/plain", { projectId: "project_1", artifactId: "artifact_1" });
    expect((await app.runtime.artifactStore.verify(reference)).valid).toBe(true);
    const path = `${app.runtime.artifactStore.root}/${reference.relativePath}`;
    const fs = await import("node:fs");
    fs.writeFileSync(path, "tampered");
    expect((await app.runtime.artifactStore.verify(reference)).valid).toBe(false);
    await app.close();
  });

  it("persists v1/v2 ArtifactVersion history, latest Artifact projection and integrity status", async () => {
    const root = useTestRoot();
    const app = await createTestApp(root);
    const project = makeProject();
    const task = makeTask(project.id);
    const artifact = { id: newObjectId("artifact"), projectId: project.id, taskId: task.id, name: "report", artifactType: "report", ownerRole: "developer", status: "created", createdAt: utcNow(), createdBy: "developer", contentRef: null, upstreamLinks: [], downstreamLinks: [], version: 1 };
    const evidence = new EvidenceRepository();
    const projects = new ProjectTaskRepository();
    app.runtime.database.transaction((connection) => { projects.createProject(connection, project); projects.createTask(connection, task); evidence.createArtifact(connection, artifact); });

    const ref1 = await app.runtime.artifactStore.put(Buffer.from("report v1"), "text/plain", { projectId: project.id, artifactId: artifact.id });
    const version1: ArtifactVersion = { id: newObjectId("artifact_version"), artifactId: artifact.id, projectId: project.id, taskId: task.id, version: 1, parentVersionId: null, changeReason: "initial", contentRef: { artifactId: artifact.id, sha256: ref1.sha256, mediaType: ref1.mediaType, size: ref1.sizeBytes, createdAt: ref1.createdAt, relativePath: ref1.relativePath, storeRef: ref1.storeRef }, storeRef: ref1.storeRef, createdAt: utcNow(), createdBy: "developer", integrityStatus: "unknown" };
    const ref2 = await app.runtime.artifactStore.put(Buffer.from("report v2"), "text/plain", { projectId: project.id, artifactId: artifact.id });
    const version2: ArtifactVersion = { id: newObjectId("artifact_version"), artifactId: artifact.id, projectId: project.id, taskId: task.id, version: 2, parentVersionId: version1.id, changeReason: "review feedback", contentRef: { artifactId: artifact.id, sha256: ref2.sha256, mediaType: ref2.mediaType, size: ref2.sizeBytes, createdAt: ref2.createdAt, relativePath: ref2.relativePath, storeRef: ref2.storeRef }, storeRef: ref2.storeRef, createdAt: utcNow(), createdBy: "developer", integrityStatus: "unknown" };
    app.runtime.database.transaction((connection) => { evidence.createArtifactVersion(connection, version1); evidence.createArtifactVersion(connection, version2); });

    const versions = evidence.listArtifactVersions(app.runtime.database.connection, artifact.id);
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(versions[1]?.parentVersionId).toBe(version1.id);
    expect(evidence.getArtifact(app.runtime.database.connection, artifact.id).contentRef?.sha256).toBe(ref2.sha256);
    expect(evidence.getArtifact(app.runtime.database.connection, artifact.id).version).toBe(2);

    const verified = await evidence.verifyArtifactVersion(app.runtime.database.connection, app.runtime.artifactStore, version2.id);
    expect(verified.valid).toBe(true);
    expect(evidence.getArtifactVersion(app.runtime.database.connection, version2.id).integrityStatus).toBe("verified");
    const tamperedPath = `${app.runtime.artifactStore.root}/${ref2.relativePath}`;
    const fs = await import("node:fs");
    fs.writeFileSync(tamperedPath, "tampered v2");
    const invalid = await evidence.verifyArtifactVersion(app.runtime.database.connection, app.runtime.artifactStore, version2.id);
    expect(invalid.valid).toBe(false);
    expect(evidence.getArtifactVersion(app.runtime.database.connection, version2.id).integrityStatus).toBe("invalid");
    await app.close();
  });

  it("supports valid Artifact TraceLinks in both directions and rejects cross-project links", async () => {
    const root = useTestRoot();
    const app = await createTestApp(root);
    const project = makeProject();
    const task = makeTask(project.id);
    const artifact = { id: newObjectId("artifact"), projectId: project.id, taskId: task.id, name: "report", artifactType: "report", ownerRole: "developer", status: "created", createdAt: utcNow(), createdBy: "developer", contentRef: null, upstreamLinks: [], downstreamLinks: [], version: 1 };
    const evidence = new EvidenceRepository();
    const projects = new ProjectTaskRepository();
    app.runtime.database.transaction((connection) => { projects.createProject(connection, project); projects.createTask(connection, task); evidence.createArtifact(connection, artifact); });
    const trace = new TraceRepository();
    app.runtime.database.transaction((connection) => trace.create(connection, { id: newObjectId("trace_link"), projectId: project.id, sourceType: "artifact", sourceId: artifact.id, targetType: "task", targetId: task.id, relation: "supports", traceId: "tr_artifact", createdAt: utcNow(), version: 1 }));
    expect(trace.listForward(app.runtime.database.connection, project.id, "artifact", artifact.id, null, 10).items[0]?.targetId).toBe(task.id);
    expect(trace.listReverse(app.runtime.database.connection, project.id, "task", task.id, null, 10).items[0]?.sourceId).toBe(artifact.id);
    expect(trace.coverage(app.runtime.database.connection, project.id, "artifact", [artifact.id, "artifact_missing"])).toEqual({ expectedCount: 2, actualCount: 1, missingIds: ["artifact_missing"] });
    expect(() => app.runtime.database.transaction((connection) => trace.create(connection, { id: newObjectId("trace_link"), projectId: project.id, sourceType: "task", sourceId: task.id, targetType: "task", targetId: "task_other_project", relation: "covers", traceId: "tr_cross", createdAt: utcNow(), version: 1 }))).toThrow();
    await app.close();
  });
});
