'use strict';
/*
 * jsonstore.js — the engine's single atomic-write/read module for the lifecycle
 * subsystem (runs store, operator profile). Zero deps, temp-then-rename durability
 * (chain_cli's pattern). The registry writers (matrix/recipes/skills) keep route_cli's
 * own writeJSONAtomic because they carry rotating backups; runs/profile do not need them.
 */
const fs = require('fs');
const path = require('path');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }

// Atomic write: object -> pretty JSON + newline, or a string verbatim. temp-then-rename.
function atomicWrite(file, data) {
  ensureDir(path.dirname(file));
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n';
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

// Resolve a dir from an env var (absolute), else the fallback.
function envDir(varName, fallback) { return process.env[varName] ? path.resolve(process.env[varName]) : fallback; }

module.exports = { ensureDir, readJSON, atomicWrite, envDir };
