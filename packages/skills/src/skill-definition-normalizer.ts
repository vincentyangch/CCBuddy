import type {
  SkillDefinition,
  SkillInputSchema,
  SkillPermission,
  SkillSource,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

const VALID_SOURCES = new Set<SkillSource>(['bundled', 'generated', 'local', 'user']);
const VALID_PERMISSIONS = new Set<SkillPermission>(['filesystem', 'network', 'shell', 'env']);

function normalizeSchemaProperties(value: unknown): SkillInputSchema['properties'] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const properties: SkillInputSchema['properties'] = {};
  for (const [name, definition] of Object.entries(value)) {
    if (!isRecord(definition) || !isString(definition.type)) {
      return undefined;
    }

    const normalizedProperty: SkillInputSchema['properties'][string] = {
      type: definition.type,
    };

    if (definition.description !== undefined) {
      if (!isString(definition.description)) {
        return undefined;
      }

      normalizedProperty.description = definition.description;
    }

    if (definition.enum !== undefined) {
      if (!Array.isArray(definition.enum) || !definition.enum.every(isString)) {
        return undefined;
      }

      normalizedProperty.enum = definition.enum;
    }

    if (definition.default !== undefined) {
      normalizedProperty.default = definition.default;
    }

    properties[name] = normalizedProperty;
  }

  return properties;
}

function normalizeInputSchema(value: unknown): SkillInputSchema | undefined {
  if (!isRecord(value) || value.type !== 'object') {
    return undefined;
  }

  const properties = normalizeSchemaProperties(value.properties);
  if (!properties) {
    return undefined;
  }

  const inputSchema: SkillInputSchema = {
    type: 'object',
    properties,
  };

  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || !value.required.every(isString)) {
      return undefined;
    }

    inputSchema.required = value.required;
  }

  return inputSchema;
}

function normalizePermissions(value: unknown): SkillPermission[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const permissions: SkillPermission[] = [];
  for (const permission of value) {
    if (!isString(permission) || !VALID_PERMISSIONS.has(permission as SkillPermission)) {
      return undefined;
    }

    permissions.push(permission as SkillPermission);
  }

  return permissions;
}

export function normalizeSkillDefinition(value: unknown): SkillDefinition | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { name, description, version, source, filePath, inputSchema, permissions, enabled, requiresApproval } = value;

  if (
    !isString(name)
    || !isString(description)
    || !isString(version)
    || !isString(source)
    || !VALID_SOURCES.has(source as SkillSource)
    || !isString(filePath)
    || !isBoolean(enabled)
  ) {
    return undefined;
  }

  const normalizedInputSchema = normalizeInputSchema(inputSchema);
  const normalizedPermissions = normalizePermissions(permissions);

  if (!normalizedInputSchema || !normalizedPermissions) {
    return undefined;
  }

  if (requiresApproval !== undefined && !isBoolean(requiresApproval)) {
    return undefined;
  }

  return {
    name,
    description,
    version,
    source: source as SkillSource,
    filePath,
    inputSchema: normalizedInputSchema,
    permissions: normalizedPermissions,
    enabled,
    ...(requiresApproval !== undefined ? { requiresApproval } : {}),
  };
}
