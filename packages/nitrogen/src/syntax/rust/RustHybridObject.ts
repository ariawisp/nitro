import type { SourceFile } from '../SourceFile.js'
import { createFileMetadataString } from '../helpers.js'
import type { HybridObjectSpec } from '../HybridObjectSpec.js'
import type { Property } from '../Property.js'
import type { Method } from '../Method.js'
import { OptionalType } from '../types/OptionalType.js'
import { getTypeAs } from '../types/getTypeAs.js'
import { EnumType } from '../types/EnumType.js'
import { VariantType } from '../types/VariantType.js'
import { FunctionType } from '../types/FunctionType.js'
import { StructType } from '../types/StructType.js'
import { NamedWrappingType } from '../types/NamedWrappingType.js'
import type { NamedType, Type } from '../types/Type.js'
import { NitroConfig } from '../../config/NitroConfig.js'

/**
 * Converts a camelCase or PascalCase string to snake_case
 */
function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '')
}

function toPascalCase(str: string): string {
  const normalized = str
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .split('_')
    .filter((segment) => segment.length > 0)
    .map(
      (segment) => segment[0]!.toUpperCase() + segment.slice(1).toLowerCase()
    )
    .join('')
  if (normalized.length === 0) {
    return 'Generated'
  }
  if (/^[0-9]/.test(normalized)) {
    return `_${normalized}`
  }
  return normalized
}

type EnumCandidate = EnumType | VariantType

const rustModuleRegistry = new Set<string>()

function unwrapOptional(type: Type): Type {
  if (type.kind === 'optional') {
    const optional = getTypeAs(type, OptionalType)
    return unwrapOptional(optional.wrappingType)
  }
  return type
}

function getEnumCandidate(type: Type): EnumCandidate | undefined {
  const concrete = unwrapOptional(type)
  if (concrete instanceof EnumType) {
    return concrete
  }
  if (concrete instanceof VariantType) {
    return concrete
  }
  return undefined
}

function getRustTypeName(type: EnumCandidate): string {
  if (type instanceof EnumType) {
    return type.enumName
  }
  if (type.aliasName != null) {
    return toPascalCase(type.aliasName)
  }
  const alias = type.getAliasName('swift')
  return toPascalCase(alias)
}

function getRustTypeCode(type: Type): string {
  try {
    return type.getCode('rust')
  } catch {
    const concrete = unwrapOptional(type)
    if (concrete instanceof EnumType) {
      return concrete.enumName
    }
    if (concrete instanceof StructType) {
      return concrete.structName
    }
    throw new Error(
      `Rust codegen does not yet support converting type "${concrete.kind}" to Rust.\n` +
        `Encountered while generating Rust type code.`
    )
  }
}

function getUnderlyingType(named: NamedType): Type {
  if (named instanceof NamedWrappingType) {
    return named.type
  }
  return named
}

function registerRustModule(file: SourceFile): void {
  if (file.language !== 'rust') return
  if (file.platform !== 'gpui') return
  if (!file.name.endsWith('.rs')) return
  if (file.subdirectory[0] === 'crate') return
  const segments = [...file.subdirectory, file.name]
  const relativePath = segments
    .filter((segment) => segment.length > 0)
    .join('/')
  rustModuleRegistry.add(relativePath)
}

function createCrateFiles(
  modules: string[],
  crateName: string
): SourceFile[] {
  if (modules.length === 0) return []

  const cargoToml = `${createFileMetadataString('Cargo.toml', '#')}

[package]
name = "${crateName}"
version = "0.1.0"
edition = "2021"
publish = false

[dependencies]
anyhow = "1"
# Update the path below to point at your local jsi crate.
# jsi = { path = "../../path/to/jsi-rs/jsi" }
`

  const includeStatements = modules
    .map(
      (modulePath) =>
        `include!(concat!(env!("CARGO_MANIFEST_DIR"), "/../${modulePath}"));`
    )
    .join('\n')

  const libRs = `${createFileMetadataString('lib.rs')}

#![allow(clippy::all)]
#![allow(dead_code)]

${includeStatements}
`

  return [
    {
      platform: 'gpui',
      language: 'rust',
      subdirectory: ['crate'],
      name: 'Cargo.toml',
      content: cargoToml,
    },
    {
      platform: 'gpui',
      language: 'rust',
      subdirectory: ['crate', 'src'],
      name: 'lib.rs',
      content: libRs,
    },
  ]
}

export function createRustCrateScaffold(): SourceFile[] {
  const modules = Array.from(rustModuleRegistry).sort()
  if (modules.length === 0) return []
  const crateName = NitroConfig.current.getGpuiCrateName()
  return createCrateFiles(modules, crateName)
}

/**
 * Creates Rust code files from a HybridObject specification.
 * Generates:
 * - Props struct with from_js_object() parser
 * - Enum types from union types
 * - Event structs from callback signatures
 */
export function createRustHybridObject(
  spec: HybridObjectSpec,
  targetPlatform: 'gpui' = 'gpui'
): SourceFile[] {
  if (targetPlatform !== 'gpui') {
    throw new Error('Rust generation is only supported for the GPUI platform.')
  }
  const files: SourceFile[] = []
  const pushFile = (file: SourceFile): void => {
    const gpuiFile = { ...file, platform: 'gpui' as const }
    registerRustModule(gpuiFile)
    files.push(gpuiFile)
  }

  // Generate props struct if there are properties
  const nonCallbackProps = spec.properties.filter(
    (p) => p.type.kind !== 'function'
  )
  if (nonCallbackProps.length > 0) {
    const propsFile = generatePropsStruct(spec, nonCallbackProps)
    pushFile(propsFile)
  }

  // Generate enums from union/variant types
  const enumTypes = collectEnumTypes(spec)
  for (const enumType of enumTypes) {
    const enumFile = generateEnum(enumType)
    if (enumFile != null) {
      pushFile(enumFile)
    }
  }

  // Generate event structs from callbacks
  const callbackProps = spec.properties.filter(
    (p) => p.type.kind === 'function'
  )
  for (const callback of callbackProps) {
    const eventFile = generateEventStruct(spec, callback)
    pushFile(eventFile)
  }

  const hybridFile = generateHybridObjectImpl(
    spec,
    nonCallbackProps,
    callbackProps,
    spec.methods
  )
  pushFile(hybridFile)

  return files
}

/**
 * Collects all enum/variant types from the spec
 */
function collectEnumTypes(spec: HybridObjectSpec): Array<{
  name: string
  type: EnumCandidate
}> {
  const enums = new Map<string, EnumCandidate>()

  const register = (type: Type): void => {
    const candidate = getEnumCandidate(type)
    if (candidate == null) return
    const name = getRustTypeName(candidate)
    if (!enums.has(name)) {
      enums.set(name, candidate)
    }
  }

  for (const prop of spec.properties) {
    register(prop.type)
  }

  for (const method of spec.methods) {
    for (const param of method.parameters) {
      register(param.type)
    }
    register(method.returnType)
  }

  return Array.from(enums.entries()).map(([name, type]) => ({ name, type }))
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
      if (p.type.kind === 'optional') {
        return `            ${fieldName}: {
                let value = obj.get(prop!("${propName}", rt), rt);
                if value.is_undefined() || value.is_null() {
                    ${defaultValue}
                } else {
                    FromValue::from_value(&value, rt).or(${defaultValue})
                }
            },`
      }
      return `            ${fieldName}: {
                let value = obj.get(prop!("${propName}", rt), rt);
                FromValue::from_value(&value, rt)
                    .unwrap_or_else(|| ${defaultValue})
            },`
    })
    .join('\n')

  // Generate to_js_object serializer
  const serializers = properties
    .map((p) => {
      const fieldName = toSnakeCase(p.name)
      const propName = p.name
      const fieldAccess = p.type.kind === 'string' ? `self.${fieldName}.clone()` : `self.${fieldName}`
      return `        obj.set(prop!("${propName}", rt), &${fieldAccess}.into_value(rt), rt);`
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

use jsi::{prop, FromValue, IntoValue, JsiObject, RuntimeHandle};

/// Props for ${spec.name}
#[derive(Debug, Clone)]
pub struct ${structName} {
${fields}
}

impl ${structName} {
    /// Parse from a JavaScript object
    pub fn from_js_object<'rt>(obj: &JsiObject<'rt>, rt: &mut RuntimeHandle<'rt>) -> anyhow::Result<Self> {
        Ok(Self {
${parsers}
        })
    }

    /// Convert to a JavaScript object
    pub fn to_js_object<'rt>(&self, rt: &mut RuntimeHandle<'rt>) -> JsiObject<'rt> {
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
function generateEnum(enumDef: {
  name: string
  type: EnumCandidate
}): SourceFile | null {
  if (enumDef.type instanceof EnumType) {
    if (enumDef.type.jsType === 'union') {
      return generateStringEnum(enumDef.name, enumDef.type)
    } else {
      return generateNumericEnum(enumDef.name, enumDef.type)
    }
  } else if (enumDef.type instanceof VariantType) {
    return generateVariantEnum(enumDef.name, enumDef.type)
  }

  return null
}

function generateVariantEnum(
  enumName: string,
  variantType: VariantType
): SourceFile {
  const fileName = toSnakeCase(enumName)
  const variantUsage = new Map<string, number>()

  const variants = variantType.cases.map(([label, type]) => {
    const baseName = toPascalCase(label)
    const count = variantUsage.get(baseName) ?? 0
    variantUsage.set(baseName, count + 1)
    const rustName = count === 0 ? baseName : `${baseName}${count + 1}`
    const rustType = getRustTypeCode(type)
    return { rustName, rustType }
  })

  const variantDecls = variants
    .map((v) => `    ${v.rustName}(${v.rustType}),`)
    .join('\n')

  const fromBranches = variants
    .map(
      (v) =>
        `        if let Some(parsed) = <${v.rustType} as FromValue<'rt>>::from_value(value, rt) {
            return Some(Self::${v.rustName}(parsed));
        }`
    )
    .join('\n')

  const intoArms = variants
    .map(
      (v) => `            Self::${v.rustName}(value) => value.into_value(rt),`
    )
    .join('\n')

  const defaultVariant = variants[0]

  const defaultImpl = defaultVariant
    ? `impl Default for ${enumName} {
    fn default() -> Self {
        Self::${defaultVariant.rustName}(Default::default())
    }
}

`
    : ''

  const code = `${createFileMetadataString(`${fileName}.rs`)}

use jsi::{FromValue, IntoValue, JsiValue, RuntimeHandle};

/// ${enumName} enum generated from TypeScript variant type
#[derive(Debug, Clone)]
pub enum ${enumName} {
${variantDecls}
}

impl<'rt> FromValue<'rt> for ${enumName} {
    fn from_value(value: &JsiValue<'rt>, rt: &mut RuntimeHandle<'rt>) -> Option<Self> {
${fromBranches}
        None
    }
}

impl<'rt> IntoValue<'rt> for ${enumName} {
    fn into_value(self, rt: &mut RuntimeHandle<'rt>) -> JsiValue<'rt> {
        match self {
${intoArms}
        }
    }
}

${defaultImpl}`

  return {
    name: `${fileName}.rs`,
    content: code,
    language: 'rust',
    platform: 'shared',
    subdirectory: [],
  }
}

function generateStringEnum(enumName: string, enumType: EnumType): SourceFile {
  const fileName = toSnakeCase(enumName)
  const variantUsage = new Map<string, number>()
  const variants = enumType.enumMembers.map((member, index) => {
    const literal = member.stringValue ?? member.name.toLowerCase()
    const baseName = toPascalCase(
      member.stringValue ?? member.name ?? `Variant${index}`
    )
    const count = variantUsage.get(baseName) ?? 0
    variantUsage.set(baseName, count + 1)
    const rustName = count === 0 ? baseName : `${baseName}${count + 1}`
    return { rustName, literal }
  })

  const variantDecls = variants.map((v) => `    ${v.rustName},`).join('\n')
  const fromStrCases = variants
    .map((v) => `            "${v.literal}" => Some(Self::${v.rustName}),`)
    .join('\n')
  const asStrCases = variants
    .map((v) => `            Self::${v.rustName} => "${v.literal}",`)
    .join('\n')
  const defaultVariant = variants[0]?.rustName ?? 'Generated'

  const code = `${createFileMetadataString(`${fileName}.rs`)}

use jsi::{FromValue, IntoValue, JsiValue, RuntimeHandle};

/// ${enumName} enum generated from TypeScript union type
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ${enumName} {
${variantDecls}
}

impl ${enumName} {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
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

impl<'rt> FromValue<'rt> for ${enumName} {
    fn from_value(value: &JsiValue<'rt>, rt: &mut RuntimeHandle<'rt>) -> Option<Self> {
        let text: Option<String> = FromValue::from_value(value, rt);
        text.as_deref().and_then(Self::from_str)
    }
}

impl<'rt> IntoValue<'rt> for ${enumName} {
    fn into_value(self, rt: &mut RuntimeHandle<'rt>) -> JsiValue<'rt> {
        self.as_str().into_value(rt)
    }
}

impl Default for ${enumName} {
    fn default() -> Self {
        Self::${defaultVariant}
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

function generateNumericEnum(enumName: string, enumType: EnumType): SourceFile {
  const fileName = toSnakeCase(enumName)
  const variantUsage = new Map<string, number>()
  const variants = enumType.enumMembers.map((member, index) => {
    const baseName = toPascalCase(
      member.stringValue ?? member.name ?? `Variant${index}`
    )
    const count = variantUsage.get(baseName) ?? 0
    variantUsage.set(baseName, count + 1)
    const rustName = count === 0 ? baseName : `${baseName}${count + 1}`
    return { rustName, value: member.value }
  })

  const variantDecls = variants
    .map((v) => `    ${v.rustName} = ${v.value},`)
    .join('\n')
  const fromNumberCases = variants
    .map((v) => `            ${v.value} => Some(Self::${v.rustName}),`)
    .join('\n')
  const toNumberCases = variants
    .map((v) => `            Self::${v.rustName} => ${v.value},`)
    .join('\n')
  const defaultVariant = variants[0]?.rustName ?? 'Generated'

  const code = `${createFileMetadataString(`${fileName}.rs`)}

use jsi::{FromValue, IntoValue, JsiValue, RuntimeHandle};

/// ${enumName} enum generated from TypeScript numeric enum
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ${enumName} {
${variantDecls}
}

impl ${enumName} {
    pub fn from_i32(value: i32) -> Option<Self> {
        match value {
${fromNumberCases}
            _ => None,
        }
    }

    pub fn as_i32(&self) -> i32 {
        match self {
${toNumberCases}
        }
    }
}

impl<'rt> FromValue<'rt> for ${enumName} {
    fn from_value(value: &JsiValue<'rt>, rt: &mut RuntimeHandle<'rt>) -> Option<Self> {
        let raw: Option<f64> = FromValue::from_value(value, rt);
        raw.and_then(|num| Self::from_i32(num as i32))
    }
}

impl<'rt> IntoValue<'rt> for ${enumName} {
    fn into_value(self, rt: &mut RuntimeHandle<'rt>) -> JsiValue<'rt> {
        self.as_i32().into_value(rt)
    }
}

impl Default for ${enumName} {
    fn default() -> Self {
        Self::${defaultVariant}
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
  const eventName = `${toPascalCase(callback.name.replace(/^on/, ''))}Event`
  const fileName = toSnakeCase(eventName)

  if (!(callback.type instanceof FunctionType)) {
    throw new Error(
      `Expected callback property ${callback.name} to be a FunctionType when generating Rust events.`
    )
  }

  const fnType = callback.type

  interface EventField {
    fieldName: string
    jsName: string
    rustType: string
  }

  const eventFields: EventField[] = []

  const pushField = (name: string, type: NamedType): void => {
    const rustType = getRustTypeCode(type)
    eventFields.push({
      fieldName: toSnakeCase(name),
      jsName: name,
      rustType,
    })
  }

  if (fnType.parameters.length === 1) {
    const parameter = fnType.parameters[0]!
    const underlying = unwrapOptional(getUnderlyingType(parameter))
    if (underlying instanceof StructType) {
      for (const structProp of underlying.properties) {
        pushField(structProp.name, structProp)
      }
    } else {
      pushField(parameter.name, parameter)
    }
  } else {
    for (const parameter of fnType.parameters) {
      pushField(parameter.name, parameter)
    }
  }

  const fields =
    eventFields.length === 0
      ? ''
      : eventFields
          .map((field) => `    pub ${field.fieldName}: ${field.rustType},`)
          .join('\n')

  const toJsFields =
    eventFields.length === 0
      ? ''
      : eventFields
          .map(
            (field) =>
              `        obj.set(prop!("${field.jsName}", rt), &self.${field.fieldName}.into_value(rt), rt);`
          )
          .join('\n')

  const code = `${createFileMetadataString(`${fileName}.rs`)}

use jsi::{prop, IntoValue, JsiObject, RuntimeHandle};

/// Event data for ${callback.name} callback
#[derive(Debug, Clone)]
pub struct ${eventName} {
${fields}
}

impl ${eventName} {
    /// Convert to a JavaScript object for passing to callbacks
    pub fn to_js_object<'rt>(&self, rt: &mut RuntimeHandle<'rt>) -> JsiObject<'rt> {
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

function generateHybridObjectImpl(
  spec: HybridObjectSpec,
  properties: Property[],
  callbacks: Property[],
  methods: Method[]
): SourceFile {
  const implType = spec.name
  const fileName = `${toSnakeCase(spec.name)}_hybrid`
  const propsStructName = `${spec.name}Props`
  const hasProps = properties.length > 0
  const hasCallbacks = callbacks.length > 0

  const setPropsBody = hasProps
    ? `        if let Some(props_obj) = JsiObject::from_value(&props, rt) {
            match ${propsStructName}::from_js_object(&props_obj, rt) {
                Ok(parsed_props) => {
                    // TODO: apply parsed props to your native state
                    let _ = parsed_props;
                }
                Err(err) => {
                    // TODO: surface parsing error (log, metrics, etc.)
                    let _ = err;
                }
            }
        } else {
            // TODO: handle non-object props payloads if needed
        }
`
    : '        let _ = (rt, props);\n'

  const callbackComment = hasCallbacks
    ? '        // TODO: register callback props (e.g., store JsiFn handles)\n'
    : ''

  const methodStubs = methods
    .map((method) => generateHybridMethodStub(method))
    .filter((stub) => stub.length > 0)
    .join('\n\n')

  const code = `${createFileMetadataString(`${fileName}.rs`)}

use jsi::{hybrid_method, hybrid_object, JsiObject, JsiValue, RuntimeHandle};

#[hybrid_object("${spec.name}")]
impl ${implType} {
    /// Update native state from the latest JS props snapshot.
    #[hybrid_method]
    pub fn set_props<'rt>(&self, rt: &mut RuntimeHandle<'rt>, props: JsiValue<'rt>) {
${setPropsBody}${callbackComment}
    }

${methodStubs}
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

function generateHybridMethodStub(method: Method): string {
  const methodName = toSnakeCase(method.name)
  const params = method.parameters.map((param) => {
    const paramName = toSnakeCase(param.name)
    return `${paramName}: JsiValue<'rt>`
  })
  const paramsSignature = params.length > 0 ? `, ${params.join(', ')}` : ''
  const parameterNames = method.parameters.map((param) =>
    toSnakeCase(param.name)
  )
  const bindingTuple = `rt${parameterNames.map((name) => `, ${name}`).join('')}`
  const bindingLine = `        let _ = (${bindingTuple});`
  const returnType = method.returnType.kind === 'void' ? '()' : "JsiValue<'rt>"

  const body =
    method.returnType.kind === 'void'
      ? `${bindingLine}\n        todo!("Implement ${method.name}()");`
      : `${bindingLine}\n        todo!("Implement ${method.name}()");`

  return `    #[hybrid_method]
    pub fn ${methodName}<'rt>(&self, rt: &mut RuntimeHandle<'rt>${paramsSignature}) -> ${returnType} {
${body}
    }`
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
