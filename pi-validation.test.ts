// pi-validation.test.ts
// pi-validation.ts の挙動を Node.js 組み込みの node:test + node:assert で検証する。

import { describe, it } from "node:test";
import { ok, strict as assert } from "node:assert";
import { validateCliOverrides } from "./pi-projects";

// ===== テスト =====

describe("validateCliOverrides", () => {
  it("全フィールド未指定なら空オブジェクトを返す", () => {
    const result = validateCliOverrides({});
    assert.deepEqual(result, {});
  });

  it("provider / model / apiKeyEnv いずれも指定すればそのまま返す", () => {
    const result = validateCliOverrides({
      apiKeyEnv: "WORK_API_KEY",
      model: "deepseek-v4-flash:xhigh",
      provider: "opencode-go",
    });
    assert.deepEqual(result, {
      apiKeyEnv: "WORK_API_KEY",
      model: "deepseek-v4-flash:xhigh",
      provider: "opencode-go",
    });
  });

  it("model にコロン区切り書式 (thinkingLevel) を許容する", () => {
    const result = validateCliOverrides({ model: "deepseek-v4-flash:xhigh" });
    assert.equal(result.model, "deepseek-v4-flash:xhigh");
  });

  it("provider にシェルメタ文字を含む値は拒否する", () => {
    assert.throws(
      () => validateCliOverrides({ provider: "opencode-go;rm -rf /" }),
      /provider/,
    );
  });

  it("model にシェルメタ文字を含む値は拒否する", () => {
    assert.throws(
      () => validateCliOverrides({ model: "deepseek-v4-flash$x" }),
      /model/,
    );
  });

  it("apiKeyEnv にドットを含む POSIX 違反の値は拒否する", () => {
    assert.throws(
      () => validateCliOverrides({ apiKeyEnv: "WORK.API.KEY" }),
      /apiKeyEnv/,
    );
  });

  it("空文字の apiKeyEnv は拒否する", () => {
    assert.throws(
      () => validateCliOverrides({ apiKeyEnv: "" }),
      /apiKeyEnv/,
    );
  });
});

