import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { Trace, ValidationResult } from "./types.js";

const schemaPath = fileURLToPath(
  new URL("../../schemas/trace.schema.json", import.meta.url),
);

let validatorPromise: Promise<ValidateFunction> | undefined;

async function getValidator() {
  if (!validatorPromise) {
    validatorPromise = readFile(schemaPath, "utf8").then((rawSchema) => {
      const ajv = new Ajv2020({
        allErrors: true,
        strict: true,
      });
      const addFormats = (
        (addFormatsModule as { default?: unknown }).default ?? addFormatsModule
      ) as (target: Ajv2020) => void;
      addFormats(ajv);
      return ajv.compile(JSON.parse(rawSchema));
    });
  }

  return validatorPromise;
}

export async function validateTrace(input: unknown): Promise<ValidationResult> {
  const validate = await getValidator();
  const ok = validate(input);

  return {
    ok,
    errors: ok ? [] : formatErrors(validate.errors ?? []),
  };
}

export async function assertValidTrace(input: unknown): Promise<Trace> {
  const result = await validateTrace(input);

  if (!result.ok) {
    throw new Error(`Invalid Vibe Trace:\n${result.errors.join("\n")}`);
  }

  return input as Trace;
}

function formatErrors(errors: ErrorObject[]): string[] {
  return errors.map((error) => {
    const path = error.instancePath || "/";
    return `${path} ${error.message ?? "is invalid"}`;
  });
}
