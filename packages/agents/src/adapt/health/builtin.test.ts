import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectProject } from "@opscrew/detect";
import { afterEach, describe, expect, it } from "vitest";
import { deriveCodeChanges, healthRouteFor } from "../../design/code-changes";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A project in a temp folder: repo-relative path → text. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-builtin-health-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

/** The plan's health path and whether design asks for a health-endpoint change. */
async function planned(files: Record<string, string>) {
  const facts = await detectProject(await project(files));
  return {
    path: healthRouteFor(facts).path,
    change: deriveCodeChanges(facts).some((change) => change.kind === "health-endpoint"),
  };
}

describe("frameworks that answer a health check by themselves", () => {
  it("Rails 7.1+: the plan checks /up and asks for no health route", async () => {
    expect(
      await planned({
        Gemfile: 'source "https://rubygems.org"\ngem "rails", "~> 7.1.3"\ngem "puma"\n',
        "config/routes.rb": [
          "Rails.application.routes.draw do",
          "  # Reveal health status on /up that returns 200 if the app boots with no exceptions.",
          '  get "up" => "rails/health#show", as: :rails_health_check',
          '  root "posts#index"',
          "end",
        ].join("\n"),
        "app/controllers/posts_controller.rb":
          "class PostsController < ApplicationController\nend\n",
      }),
    ).toEqual({ path: "/up", change: false });
  });

  it("Laravel 11+: the plan checks /up and asks for no health route", async () => {
    expect(
      await planned({
        "composer.json": JSON.stringify({
          require: { php: "^8.2", "laravel/framework": "^11.31" },
        }),
        "bootstrap/app.php": [
          "<?php",
          "",
          "use Illuminate\\Foundation\\Application;",
          "",
          "return Application::configure(basePath: dirname(__DIR__))",
          "    ->withRouting(",
          "        web: __DIR__.'/../routes/web.php',",
          "        commands: __DIR__.'/../routes/console.php',",
          "        health: '/up',",
          "    )",
          "    ->create();",
        ].join("\n"),
        "routes/web.php": "<?php\n\nRoute::get('/', fn () => view('welcome'));\n",
      }),
    ).toEqual({ path: "/up", change: false });
  });

  it("Spring Boot Actuator: the plan checks /actuator/health and asks for no health route", async () => {
    expect(
      await planned({
        "pom.xml": [
          "<project>",
          "  <dependencies>",
          "    <dependency>",
          "      <groupId>org.springframework.boot</groupId>",
          "      <artifactId>spring-boot-starter-actuator</artifactId>",
          "    </dependency>",
          "  </dependencies>",
          "</project>",
        ].join("\n"),
        "src/main/java/com/example/demo/DemoApplication.java":
          "package com.example.demo;\n\npublic class DemoApplication {}\n",
      }),
    ).toEqual({ path: "/actuator/health", change: false });
  });
});
