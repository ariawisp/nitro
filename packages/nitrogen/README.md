<a href="https://margelo.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../docs/static/img/banner-nitrogen-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="../../docs/static/img/banner-nitrogen-light.png" />
    <img alt="Nitrogen" src="../../docs/static/img/banner-nitrogen-light.png" />
  </picture>
</a>

<br />

**Nitrogen** is a code-generator that takes TypeScript interfaces and generates C++, Swift and Kotlin code and native bindings built on top of the [**react-native-nitro-modules**](../react-native-nitro-modules/) core APIs.

## Installation

Install [nitrogen](https://npmjs.org/nitrogen) as a `devDependency` in your Nitro Module:
```sh
npm i nitrogen -D
```

Then, generate your specs;

```sh
npx nitrogen
```

## Usage

See the [Nitrogen documentation](https://nitro.margelo.com/docs/nitrogen) for more information.

## GPUI Rust Platform

Nitrogen can generate GPUI-ready Rust bindings by declaring `{ gpui: 'rust' }` in your `HybridObject` or `HybridView` specs:

```ts
interface ButtonProps extends HybridObject<{ gpui: 'rust' }> {
  readonly title: string
}
```

The generated files land in `nitrogen/generated/gpui/<subdir>` (`rust` by default) without any iOS or Android autolinking glue. Consumers are responsible for wiring the crate into their GPUI build.

You can configure the output via a `gpui` block in `nitro.json`:

```json
{
  "gpui": {
    "crateName": "my_gpui_bridge",
    "outputSubdirectory": ["rust"]
  }
}
```

When Rust source files are emitted, Nitrogen also scaffolds a Cargo crate under `generated/gpui/.../crate` using the optional `crateName`.

> **Note:** iOS and Android specs no longer accept `'rust'` as an implementation language. Use Swift/Kotlin/C++ for those platforms and reserve Rust codegen for GPUI targets.
