/**
 * `@opscrew/agents/testing`: the fakes the agents, CLI and MCP server tests share (phase deps,
 * projects, IaC engines, servers, Cloudflare, GitHub, registrars, Portainer). Tests only: nothing
 * here reaches the network, a real server or a real cloud.
 */
export * from "./catalog";
export * from "./connect";
export * from "./deploy";
export * from "./deps";
export * from "./destroy";
export * from "./domain";
export * from "./move";
export * from "./own";
export * from "./portainer";
export * from "./registrars";
export * from "./sops";
export * from "./state";
