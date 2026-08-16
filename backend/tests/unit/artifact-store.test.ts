import { describe, expect, it } from "vitest";
import {
  ArtifactIntegrityError,
  ArtifactTooLargeError,
} from "../../src/domain/errors.js";
import { FileArtifactStore } from "../../src/infra/artifacts.js";
import { useTestRoot } from "../helpers.js";

describe("content-addressed Artifact Store", () => {
  it("rejects oversized content before writing a file", async () => {
    const store = new FileArtifactStore(`${useTestRoot()}/artifacts`, 4);

    await expect(
      store.put(Buffer.from("12345"), "text/plain", {
        projectId: "project_artifact",
      }),
    ).rejects.toBeInstanceOf(ArtifactTooLargeError);
    expect(store.projectFileCount("project_artifact")).toBe(0);
  });

  it("binds reads to the referenced project and verifies content", async () => {
    const store = new FileArtifactStore(`${useTestRoot()}/artifacts`);
    const reference = await store.put(
      Buffer.from("immutable evidence"),
      "text/plain",
      { projectId: "project_artifact" },
    );

    await expect(store.get(reference)).resolves.toEqual(
      Buffer.from("immutable evidence"),
    );
    await expect(
      store.get({ ...reference, projectId: "other_project" }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await expect(
      store.get({ ...reference, relativePath: `../${reference.relativePath}` }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });
});
