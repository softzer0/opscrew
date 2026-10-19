import { describe, expect, it } from "vitest";
import { type Dependency, readUnits } from "./manifests";

/** The dependencies of a single unit made of `files`. */
async function dependenciesOf(files: Record<string, string>): Promise<Dependency[]> {
  const units = await readUnits(Object.keys(files), async (path) => files[path]);
  expect(units).toHaveLength(1);
  return units[0]?.dependencies ?? [];
}

const names = (deps: Dependency[], dev: boolean) =>
  deps.filter((dep) => dep.dev === dev).map((dep) => dep.name);

describe("manifests of more ecosystems", () => {
  it("reads go.mod requirements without indirect ones, the major version suffix dropped", async () => {
    const deps = await dependenciesOf({
      "go.mod": [
        "module example.com/app",
        "",
        "go 1.23",
        "",
        "require github.com/hibiken/asynq v0.25.1",
        "",
        "require (",
        "\tgithub.com/redis/go-redis/v9 v9.7.0",
        "\tgo.mongodb.org/mongo-driver/v2 v2.1.0 // a comment",
        "\tgithub.com/cespare/xxhash/v2 v2.3.0 // indirect",
        ")",
        "",
      ].join("\n"),
    });
    expect(deps.every((dep) => dep.ecosystem === "go" && !dep.dev)).toBe(true);
    expect(names(deps, false)).toEqual([
      "github.com/hibiken/asynq",
      "github.com/redis/go-redis",
      "go.mongodb.org/mongo-driver",
    ]);
  });

  it("reads pom.xml dependencies, test scope as dev, and skips managed and plugin ones", async () => {
    const deps = await dependenciesOf({
      "pom.xml": `<project>
  <dependencyManagement><dependencies>
    <dependency><groupId>org.springframework.cloud</groupId><artifactId>spring-cloud-dependencies</artifactId></dependency>
  </dependencies></dependencyManagement>
  <dependencies>
    <!-- <dependency><groupId>x</groupId><artifactId>commented</artifactId></dependency> -->
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-amqp</artifactId>
    </dependency>
    <dependency>
      <groupId>org.testcontainers</groupId>
      <artifactId>mongodb</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build><plugins><plugin><dependencies>
    <dependency><groupId>com.mysql</groupId><artifactId>mysql-connector-j</artifactId></dependency>
  </dependencies></plugin></plugins></build>
</project>`,
    });
    expect(names(deps, false)).toEqual(["org.springframework.boot:spring-boot-starter-amqp"]);
    expect(names(deps, true)).toEqual(["org.testcontainers:mongodb"]);
  });

  it("reads Gradle dependencies, test and development configurations as dev", async () => {
    const deps = await dependenciesOf({
      "build.gradle.kts": `dependencies {
    implementation(platform("org.springframework.boot:spring-boot-dependencies:3.4.0"))
    implementation("org.springframework.kafka:spring-kafka")
    runtimeOnly("org.postgresql:postgresql:42.7.4")
    testImplementation("io.nats:jnats:2.20.0")
    developmentOnly 'org.springframework.boot:spring-boot-devtools'
}`,
    });
    expect(names(deps, false)).toEqual([
      "org.postgresql:postgresql",
      "org.springframework.kafka:spring-kafka",
    ]);
    expect(names(deps, true)).toEqual([
      "io.nats:jnats",
      "org.springframework.boot:spring-boot-devtools",
    ]);
  });

  it("resolves Gradle version-catalog aliases and skips constraints", async () => {
    const files: Record<string, string> = {
      "build.gradle.kts": `dependencies {
    implementation(libs.spring.kafka)
    runtimeOnly(libs.postgres)
    testImplementation(libs.nats)
    implementation(platform(libs.spring.boot.bom))
    constraints {
        implementation("com.mysql:mysql-connector-j:9.0.0")
    }
}`,
      "gradle/libs.versions.toml": `[versions]
kafka = "3.3.0"

[libraries]
spring-kafka = { module = "org.springframework.kafka:spring-kafka", version.ref = "kafka" }
nats = { group = "io.nats", name = "jnats", version = "2.20.0" }
postgres = "org.postgresql:postgresql:42.7.4"
spring_boot_bom = { module = "org.springframework.boot:spring-boot-dependencies", version = "3.4.0" }
`,
    };
    const units = await readUnits(Object.keys(files), async (path) => files[path]);
    const deps = units[0]?.dependencies ?? [];
    expect(names(deps, false)).toEqual([
      "org.postgresql:postgresql",
      "org.springframework.kafka:spring-kafka",
    ]);
    expect(names(deps, true)).toEqual(["io.nats:jnats"]);
  });

  it("reads NuGet package references, a test project's as dev", async () => {
    const web = await dependenciesOf({
      "Api.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup>
  <PackageReference Include="MongoDB.Driver" Version="3.1.0" />
  <PackageReference Include="Confluent.Kafka">
    <Version>2.6.1</Version>
  </PackageReference>
</ItemGroup></Project>`,
    });
    expect(names(web, false)).toEqual(["Confluent.Kafka", "MongoDB.Driver"]);
    const tests = await dependenciesOf({
      "Api.Tests.csproj": `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
  <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
  <PackageReference Include="RabbitMQ.Client" Version="7.0.0" />
</ItemGroup></Project>`,
    });
    expect(names(tests, false)).toEqual([]);
  });

  it("marks gems in development and test groups as dev", async () => {
    const deps = await dependenciesOf({
      Gemfile: `source "https://rubygems.org"
gem "rails", "~> 8.0"
gem "debug", group: :development
gem "rspec-rails", groups: [:development, :test]
gem "aws-sdk-s3", require: false
group :development, :test do
  gem "sqlite3"
  platforms :mri do
    gem "byebug"
  end
end
group :production do
  gem "pg"
end
gem "sidekiq"
`,
    });
    expect(names(deps, false)).toEqual(["aws-sdk-s3", "pg", "rails", "sidekiq"]);
    expect(names(deps, true)).toEqual(["byebug", "debug", "rspec-rails", "sqlite3"]);
  });
});
