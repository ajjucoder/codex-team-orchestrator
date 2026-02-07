import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const schemaRoot = join(here, '..', 'schemas');

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadSchemaDir(subdir) {
  const dirPath = join(schemaRoot, subdir);
  const schemas = {};
  for (const file of readdirSync(dirPath)) {
    if (file.endsWith('.json')) {
      schemas[file] = loadJson(join(dirPath, file));
    }
  }
  return schemas;
}

export const entitySchemas = loadSchemaDir('entities');
export const toolSchemas = loadSchemaDir('tools');

function validateType(expectedType, value) {
  if (expectedType === 'integer') return Number.isInteger(value);
  if (expectedType === 'array') return Array.isArray(value);
  if (expectedType === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === expectedType;
}

function validateSchema(schema, value, path = '$') {
  const errors = [];

  if (schema.type && !validateType(schema.type, value)) {
    errors.push(`${path}: expected ${schema.type}`);
    return errors;
  }

  if (schema.type === 'object') {
    const props = schema.properties || {};
    const required = schema.required || [];

    for (const key of required) {
      if (!(key in value)) {
        errors.push(`${path}.${key}: is required`);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          errors.push(`${path}.${key}: additional property not allowed`);
        }
      }
    }

    for (const [key, propSchema] of Object.entries(props)) {
      if (!(key in value)) continue;
      errors.push(...validateSchema(propSchema, value[key], `${path}.${key}`));
    }

    if (schema.allOf) {
      for (const conditional of schema.allOf) {
        if (conditional.if?.properties) {
          let conditionMet = true;
          for (const [ifKey, ifSchema] of Object.entries(conditional.if.properties)) {
            if (ifSchema.const !== undefined && value[ifKey] !== ifSchema.const) {
              conditionMet = false;
            }
          }
          if (conditionMet && conditional.then?.required) {
            for (const key of conditional.then.required) {
              if (!(key in value)) {
                errors.push(`${path}.${key}: is required by conditional`);
              }
            }
          }
        }
      }
    }
  }

  if (schema.type === 'array' && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      errors.push(...validateSchema(schema.items, value[i], `${path}[${i}]`));
    }
  }

  if (schema.type === 'string' && schema.pattern) {
    const re = new RegExp(schema.pattern);
    if (!re.test(value)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }

  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) {
      errors.push(`${path}: expected integer`);
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${schema.enum.join(', ')}`);
  }

  return errors;
}

export function validateEntity(schemaFileName, payload) {
  const schema = entitySchemas[schemaFileName];
  if (!schema) {
    return { ok: false, errors: [`unknown entity schema: ${schemaFileName}`] };
  }
  const errors = validateSchema(schema, payload);
  return { ok: errors.length === 0, errors };
}

export function validateTool(schemaFileName, payload) {
  const schema = toolSchemas[schemaFileName];
  if (!schema) {
    return { ok: false, errors: [`unknown tool schema: ${schemaFileName}`] };
  }
  const errors = validateSchema(schema, payload);
  return { ok: errors.length === 0, errors };
}
