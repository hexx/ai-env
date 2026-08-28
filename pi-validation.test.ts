// pi-validation.test.ts
// pi-validation.ts の挙動を Node.js 組み込みの node:test + node:assert で検証する。

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  validateCliOverrides,
  validateProfileCredentialAccess,
} from "./pi-projects";
import { type ProfileConfig } from "./pi-types";

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

  it("session を指定すればそのまま返す(部分 ID も許容)", () => {
    const result = validateCliOverrides({
      session: "019fe743-77fc-7ad5-82dd-4f64e7c64517",
    });
    assert.deepEqual(result, {
      session: "019fe743-77fc-7ad5-82dd-4f64e7c64517",
    });
    // pi の --session はプレフィックス一致に対応しているため部分 ID も通す。
    const partial = validateCliOverrides({ session: "019fe743" });
    assert.equal(partial.session, "019fe743");
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

  it("session にシェルメタ文字を含む値は拒否する", () => {
    assert.throws(
      () => validateCliOverrides({ session: "019fe743;rm -rf /" }),
      /session/,
    );
  });

  it("session に空白を含む値は拒否する", () => {
    assert.throws(
      () => validateCliOverrides({ session: "019f e743" }),
      /session/,
    );
  });

  it("空文字の session は拒否する", () => {
    assert.throws(
      () => validateCliOverrides({ session: "" }),
      /session/,
    );
  });
});

// ===== credentialKeys と CLI / Project の整合性 =====

describe("validateProfileCredentialAccess", () => {
  const profile: ProfileConfig = {
    credentialKeys: ["OPENAI_API_KEY", "OPENCODE_API_KEY"],
    OCR_USE_ANTHROPIC: "false",
    OCR_LLM_URL: "https://opencode.ai/zen/go/v1",
    OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
    OCR_LLM_MODEL: "mimo-v2.5-pro",
  };

  it("許可リスト内のProfile / Project / CLI設定を許可する", () => {
    assert.doesNotThrow(() =>
      validateProfileCredentialAccess({
        configPath: "test.json",
        hostProjectName: "ai-env",
        profileName: "pi-private",
        profile: { ...profile, apiKeyEnv: "OPENAI_API_KEY" },
        projects: {
          "ai-env": { apiKeyEnv: "OPENCODE_API_KEY" },
        },
        cliApiKeyEnv: "OPENAI_API_KEY",
      }),
    );
  });

  it("OCR_LLM_TOKEN_KEYがProfileの許可リスト外なら拒否する", () => {
    assert.throws(
      () =>
        validateProfileCredentialAccess({
          configPath: "test.json",
          hostProjectName: "ai-env",
          profileName: "pi-private",
          profile: { ...profile, OCR_LLM_TOKEN_KEY: "OPENROUTER_API_KEY" },
          projects: {},
        }),
      /credentialKeys|OPENROUTER_API_KEY/,
    );
  });

  it("CLIのapiKeyEnvでProfileの許可リストを迂回できない", () => {
    assert.throws(
      () =>
        validateProfileCredentialAccess({
          configPath: "test.json",
          hostProjectName: "ai-env",
          profileName: "pi-private",
          profile,
          projects: {},
          cliApiKeyEnv: "OPENROUTER_API_KEY",
        }),
      /credentialKeys|OPENROUTER_API_KEY/,
    );
  });

  it("ProjectのapiKeyEnvが許可リスト外なら拒否する", () => {
    assert.throws(
      () =>
        validateProfileCredentialAccess({
          configPath: "test.json",
          hostProjectName: "ai-env",
          profileName: "pi-private",
          profile,
          projects: {
            "ai-env": { apiKeyEnv: "OPENROUTER_API_KEY" },
          },
        }),
      /credentialKeys|OPENROUTER_API_KEY/,
    );
  });

  it("現在のProject以外のapiKeyEnv設定は検証対象にしない", () => {
    assert.doesNotThrow(() =>
      validateProfileCredentialAccess({
        configPath: "test.json",
        hostProjectName: "ai-env",
        profileName: "pi-private",
        profile,
        projects: {
          "ai-env": {},
          other: { apiKeyEnv: "OPENROUTER_API_KEY" },
        },
      }),
    );
  });
});

