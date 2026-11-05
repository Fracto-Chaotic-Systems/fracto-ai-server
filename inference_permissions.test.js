import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LocalStore } from "./inference/storage.js";

const inspect_acl = (directory) => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
      $ErrorActionPreference = 'Stop'
      $acl = [IO.Directory]::GetAccessControl($env:FRACTO_TEST_ACL_DIRECTORY)
      $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
      $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
      $unexpected = @($rules | Where-Object {
        $_.IdentityReference.Value -notin $allowed -or
        $_.AccessControlType -ne 'Allow' -or $_.IsInherited -or
        $_.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $_.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit') -or
        $_.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None
      })
      [pscustomobject]@{
        owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        protected = $acl.AreAccessRulesProtected
        restricted = ($unexpected.Count -eq 0 -and $rules.Count -eq 3)
      } | ConvertTo-Json -Compress
      `,
    ],
    {
      windowsHide: true,
      timeout: 15000,
      encoding: "utf8",
      env: { ...process.env, FRACTO_TEST_ACL_DIRECTORY: directory },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, "Local ACL inspection must succeed");
  return JSON.parse(result.stdout);
};

test(
  "Windows inference store preserves ownership and restricts inherited access",
  { skip: process.platform !== "win32" },
  (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "fracto-inference-permissions-"),
    );
    t.after(() => {
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith("fracto-inference-permissions-"));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const before = inspect_acl(directory);
    const store = new LocalStore(directory);
    try {
      const after = inspect_acl(directory);
      assert.ok(before.owner === after.owner, "Directory ownership must remain unchanged");
      assert.equal(after.protected, true);
      assert.equal(after.restricted, true);
      assert.ok(/^[a-f0-9]{64}$/.test(store.token), "A valid machine token must be generated");
      assert.equal(inspect_acl(path.join(directory, "artifacts")).protected, false);
    } finally {
      store.close();
    }
    const reopened = new LocalStore(directory);
    reopened.close();
    assert.ok(before.owner === inspect_acl(directory).owner, "Reopening must preserve ownership");
  },
);


