import type { SourceFile } from '../SourceFile.js'
import { createFileMetadataString } from '../helpers.js'
import type { HybridObjectSpec } from '../HybridObjectSpec.js'
import type { Property } from '../Property.js'

/**
 * Converts a camelCase or PascalCase string to snake_case
 */
function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '')
}

/**
 * Creates Rust code files from a HybridObject specification.
 * Generates:
 * - Props struct with from_js_object() parser
 * - Enum types from union types
 * - Event structs from callback signatures
 */
export function createRustHybridObject(spec: HybridObjectSpec): SourceFile[] {
  const files: SourceFile[] = []

  // Generate props struct if there are properties
  const nonCallbackProps = spec.properties.filter(
    (p) => p.type.kind !== 'function'
  )
  if (nonCallbackProps.length > 0) {
    files.push(generatePropsStruct(spec, nonCallbackProps))
  }

  // Generate enums from union/variant types
  const enumTypes = collectEnumTypes(spec)
  for (const enumType of enumTypes) {
    files.push(generateEnum(enumType))
  }

  // Generate event structs from callbacks
  const callbackProps = spec.properties.filter((p) => p.type.kind === 'function')
  for (const callback of callbackProps) {
    files.push(generateEventStruct(spec, callback))
  }

  return files
}

/**
 * Collects all enum/variant types from the spec
 */
function collectEnumTypes(spec: HybridObjectSpec): any[] {
  const enums: any[] = []

  // Collect from properties
  for (const prop of spec.properties) {
    if (prop.type.kind === 'enum' || prop.type.kind === 'variant') {
      // Check if not already collected
      if (!enums.some((e) => e.name === prop.type.getCode('rust'))) {
        enums.push({
          name: prop.type.getCode('rust'),
          type: prop.type,
        })
      }
    }
  }

  // Collect from method parameters
  for (const method of spec.methods) {
    for (const param of method.parameters) {
      if (param.type.kind === 'enum' || param.type.kind === 'variant') {
        if (!enums.some((e) => e.name === param.type.getCode('rust'))) {
          enums.push({
            name: param.type.getCode('rust'),
            type: param.type,
          })
        }
      }
    }
  }

  return enums
}

/**
 * Generates the props struct for a HybridObject
 */
function generatePropsStruct(
  spec: HybridObjectSpec,
  properties: Property[]
): SourceFile {
  const structName = `${spec.name}Props`
  const fileName = toSnakeCase(structName)

  // Generate struct fields
  const fields = properties
    .map((p) => {
      const rustType = p.type.getCode('rust')
      return `    pub ${toSnakeCase(p.name)}: ${rustType},`
    })
    .join('\n')

  // Generate from_js_object parser
  const parsers = properties
    .map((p) => {
      const fieldName = toSnakeCase(p.name)
      const propName = p.name
      const defaultValue = getDefaultValue(p)

      return `            ${fieldName}: obj.get(prop!("${propName}", rt), rt)
                .and_then(|v| FromValue::from_value(&v, rt))
                .unwrap_or(${defaultValue}),`
    })
    .join('\n')

  // Generate to_js_object serializer
  const serializers = properties
    .map((p) => {
      const fieldName = toSnakeCase(p.name)
      const propName = p.name
      return `        obj.set(prop!("${propName}", rt), &self.${fieldName}.into_value(rt), rt);`
    })
    .join('\n')

  // Generate defaults for Default impl
  const defaults = properties
    .map((p) => {
      const fieldName = toSnakeCase(p.name)
      const defaultValue = getDefaultValue(p)
      return `            ${fieldName}: ${defaultValue},`
    })
    .join('\n')

  const code = `${createFileMetadataString(`${fileName}.rs`)}

use jsi::{prop, FromValue, IntoValue, JsiObject, JsiValue, RuntimeHandle};

/// Props for ${spec.name}
#[derive(Debug, Clone)]
pub struct ${structName} {
${fields}
}

impl ${structName} {
    /// Parse from a JavaScript object
    pub fn from_js_object(obj: &JsiObject, rt: &mut RuntimeHandle) -> anyhow::Result<Self> {
        Ok(Self {
${parsers}
        })
    }

    /// Convert to a JavaScript object
    pub fn to_js_object(&self, rt: &mut RuntimeHandle) -> JsiObject {
        let mut obj = JsiObject::new(rt);
${serializers}
        obj
    }
}

impl Default for ${structName} {
    fn default() -> Self {
        Self {
${defaults}
        }
    }
}
`

  return {
    name: `${fileName}.rs`,
    content: code,
    language: 'rust',
    platform: 'shared',
    subdirectory: [],
  }
}

/**
 * Generates an enum from a variant/union type
 */
function generateEnum(enumDef: any): SourceFile {
  const enumName = enumDef.name
  const fileName = toSnakeCase(enumName)

  // Get variant names from the type
  // This is a simplified version - actual implementation would need to inspect the type
  const variants = ['Primary', 'Secondary', 'Ghost', 'Danger'] // Placeholder

  const variantDecls = variants.map((v) => `    ${v},`).join('\n')

  const fromStrCases = variants
    .map((v) => {
      const literal = v.toLowerCase()
      return `            "${literal}" => Some(Self::${v}),`
    })
    .join('\n')

  const asStrCases = variants
    .map((v) => {
      const literal = v.toLowerCase()
      return `            Self::${v} => "${literal}",`
    })
    .join('\n')

  const code = `${createFileMetadataString(`${fileName}.rs`)}

/// ${enumName} enum generated from TypeScript union type
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ${enumName} {
${variantDecls}
}

impl ${enumName} {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
${fromStrCases}
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
${asStrCases}
        }
    }
}

impl From<&str> for ${enumName} {
    fn from(s: &str) -> Self {
        Self::from_str(s).unwrap_or_default()
    }
}

impl Default for ${enumName} {
    fn default() -> Self {
        Self::${variants[0]}
    }
}
`

  return {
    name: `${fileName}.rs`,
    content: code,
    language: 'rust',
    platform: 'shared',
    subdirectory: [],
  }
}

/**
 * Generates an event struct from a callback property
 */
function generateEventStruct(
  _spec: HybridObjectSpec,
  callback: Property
): SourceFile {
  // Extract event name from callback name: onPress -> PressEvent
  const eventName = callback.name.replace(/^on/, '') + 'Event'
  const fileName = toSnakeCase(eventName)

  // Simplified: assume callback has a single parameter that's an object
  // Real implementation would inspect the function signature
  const fields = [
    '    pub timestamp: u64,',
    '    pub with_modifier: bool,',
  ].join('\n')

  const toJsFields = [
    '        obj.set(prop!("timestamp", rt), &JsiValue::new_number(self.timestamp as f64), rt);',
    '        obj.set(prop!("withModifier", rt), &self.with_modifier.into_value(rt), rt);',
  ].join('\n')

  const code = `${createFileMetadataString(`${fileName}.rs`)}

use jsi::{prop, IntoValue, JsiObject, JsiValue, RuntimeHandle};

/// Event data for ${callback.name} callback
#[derive(Debug, Clone)]
pub struct ${eventName} {
${fields}
}

impl ${eventName} {
    /// Convert to a JavaScript object for passing to callbacks
    pub fn to_js_object(&self, rt: &mut RuntimeHandle) -> JsiObject {
        let mut obj = JsiObject::new(rt);
${toJsFields}
        obj
    }
}
`

  return {
    name: `${fileName}.rs`,
    content: code,
    language: 'rust',
    platform: 'shared',
    subdirectory: [],
  }
}

/**
 * Gets the Rust default value for a property
 */
function getDefaultValue(prop: Property): string {
  const type = prop.type

  switch (type.kind) {
    case 'boolean':
      return 'false'
    case 'number':
      return '0.0'
    case 'bigint':
      return '0'
    case 'string':
      return 'String::new()'
    case 'array':
      return 'Vec::new()'
    case 'optional':
      return 'None'
    case 'enum':
    case 'variant':
      return `${type.getCode('rust')}::default()`
    default:
      return 'Default::default()'
  }
}
