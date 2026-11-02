"use strict";

// Endpoint string literals for stage-3 JS extraction.
const users = "/api/v1/users";
const admin = "/api/v1/admin";
const root = "/api/v1/";

function noop() {
  return users + admin + root;
}

window.fixtureNoop = noop;
