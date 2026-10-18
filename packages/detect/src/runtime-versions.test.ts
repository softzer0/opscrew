import { ProjectFactsSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "./index";
import { makeTree, removeTree } from "./test-helpers";

const roots: string[] = [];
async function versionsOf(files: Record<string, string>) {
  const root = await makeTree(files, "runtime");
  roots.push(root);
  const facts = await detectProject(root);
  expect(ProjectFactsSchema.parse(facts)).toEqual(facts);
  return facts.runtimeVersions;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

const GEMFILE = 'source "https://rubygems.org"\n\nruby "3.4.2"\n\ngem "rails", "~> 8.1.4"\n';

describe("runtime versions of Ruby, Go, Java, .NET, PHP and Rust", () => {
  it("reads Ruby from .ruby-version, else the Gemfile", async () => {
    expect(await versionsOf({ Gemfile: GEMFILE, ".ruby-version": "ruby-4.0.7\n" })).toEqual({
      ruby: "ruby-4.0.7",
    });
    expect(await versionsOf({ Gemfile: GEMFILE })).toEqual({ ruby: "3.4.2" });
    expect(await versionsOf({ Gemfile: "ruby '~> 3.3'\ngem 'sinatra'\n" })).toEqual({
      ruby: "~> 3.3",
    });
    expect(await versionsOf({ Gemfile: 'source "https://rubygems.org"\ngem "rails"\n' })).toEqual(
      {},
    );
  });

  it("reads Go from go.mod's toolchain, else its go line", async () => {
    const goMod = "module example.com/api\n\ngo 1.26\n\ntoolchain go1.26.9\n\nrequire (\n)\n";
    expect(await versionsOf({ "go.mod": goMod, "main.go": "package main\n" })).toEqual({
      go: "1.26.9",
    });
    expect(await versionsOf({ "go.mod": "module example.com/api\n\ngo 1.25.3\n" })).toEqual({
      go: "1.25.3",
    });
  });

  it("reads Java from Maven's release or java.version, or Gradle's toolchain", async () => {
    const pom = (properties: string) =>
      `<project>\n  <properties>\n${properties}\n  </properties>\n</project>\n`;
    expect(
      await versionsOf({
        "pom.xml": pom(
          "    <java.version>17</java.version>\n    <maven.compiler.release>21</maven.compiler.release>",
        ),
      }),
    ).toEqual({ java: "21" });
    expect(await versionsOf({ "pom.xml": pom("    <java.version>21</java.version>") })).toEqual({
      java: "21",
    });
    const gradle =
      "plugins { id 'java' }\njava {\n  toolchain {\n    languageVersion = JavaLanguageVersion.of(21)\n  }\n}\n";
    expect(await versionsOf({ "build.gradle": gradle })).toEqual({ java: "21" });
    const kts =
      "java {\n  toolchain {\n    languageVersion.set(JavaLanguageVersion.of(25))\n  }\n}\n";
    expect(await versionsOf({ "build.gradle.kts": kts })).toEqual({ java: "25" });
  });

  it("follows a Maven property reference to the real value and ignores commented-out ones", async () => {
    const pom = (properties: string) =>
      `<project>\n  <properties>\n${properties}\n  </properties>\n</project>\n`;
    const property = ["$", "{java.version}"].join("");
    const reference = pom(
      `    <java.version>21</java.version>\n    <maven.compiler.release>${property}</maven.compiler.release>`,
    );
    expect(await versionsOf({ "pom.xml": reference })).toEqual({ java: "21" });
    const commented = pom(
      "    <!-- <maven.compiler.release>17</maven.compiler.release> -->\n    <!--\n    <java.version>11</java.version>\n    -->\n    <java.version>25</java.version>",
    );
    expect(await versionsOf({ "pom.xml": commented })).toEqual({ java: "25" });
  });

  const csproj = (sdk: string, framework: string) =>
    `<Project Sdk="${sdk}">\n  <PropertyGroup>\n    <TargetFramework>${framework}</TargetFramework>\n  </PropertyGroup>\n</Project>\n`;

  it("reads .NET from the project file's TargetFramework", async () => {
    const web = csproj("Microsoft.NET.Sdk.Web", "net10.0");
    expect(await versionsOf({ "dotnet-api.csproj": web, "Program.cs": "" })).toEqual({
      dotnet: "10.0",
    });
    expect(await versionsOf({ "src/Api/Api.csproj": web })).toEqual({ dotnet: "10.0" });
  });

  it("prefers the web project among projects equally deep, and skips test projects", async () => {
    expect(
      await versionsOf({
        "src/Api/Api.csproj": csproj("Microsoft.NET.Sdk.Web", "net10.0"),
        "src/Alpha/Alpha.csproj": csproj("Microsoft.NET.Sdk", "net8.0"),
        "tests/Api.Tests/Api.Tests.csproj": csproj("Microsoft.NET.Sdk", "net9.0"),
      }),
    ).toEqual({ dotnet: "10.0" });
    expect(
      await versionsOf({
        "Alpha.Tests/Alpha.Tests.csproj": csproj("Microsoft.NET.Sdk", "net9.0"),
        "Zeta/Zeta.csproj": csproj("Microsoft.NET.Sdk.Worker", "net10.0"),
      }),
    ).toEqual({ dotnet: "10.0" });
  });

  it("reads PHP from composer.json's require.php", async () => {
    const composer = JSON.stringify({ require: { php: "^8.4", "laravel/framework": "^13.0" } });
    expect(await versionsOf({ "composer.json": composer })).toEqual({ php: "^8.4" });
    expect(await versionsOf({ "composer.json": JSON.stringify({ require: {} }) })).toEqual({});
  });

  it("reads Rust from rust-toolchain.toml's channel, else rust-toolchain", async () => {
    const cargo = '[package]\nname = "rust-api"\nedition = "2024"\n';
    expect(
      await versionsOf({
        "Cargo.toml": cargo,
        "rust-toolchain.toml": '[toolchain]\nchannel = "1.85.1"\ncomponents = ["clippy"]\n',
      }),
    ).toEqual({ rust: "1.85.1" });
    expect(await versionsOf({ "Cargo.toml": cargo, "rust-toolchain": "1.84.0\n" })).toEqual({
      rust: "1.84.0",
    });
    expect(await versionsOf({ "Cargo.toml": cargo })).toEqual({});
  });
});
