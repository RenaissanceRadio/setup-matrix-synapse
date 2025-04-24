import { info, getInput, saveState, setFailed, setOutput, getMultilineInput, getBooleanInput } from '@actions/core';
import { exec as actionsExec } from '@actions/exec';
import { spawn } from 'child_process';
import { writeFile, openSync } from 'fs';
import { chdir, cwd } from 'process';
import { get } from 'http';

// most @actions toolkit packages have async methods
async function run() {
  try {
    info("Installing synapse");
    let installer = getInput("installer");
    if (installer == "") {
      installer = "pip"
    }

    switch (installer) {
      case "poetry": {
        // poetry requires a git checkout first
        await actionsExec("git", ["clone", "https://github.com/element-hq/synapse.git"]);
        chdir("synapse");
        await actionsExec("python", ["-m", "pip", "install", "pipx"]);
        await actionsExec("python", ["-m", "pipx", "ensurepath"]);
        await actionsExec("pipx", ["install", "poetry==2.1.1"]);
        await actionsExec("pipx", ["list", "--verbose", "--include-injected"]);
        await actionsExec("poetry", ["install", "-vv", "--extras", "all"]);
        break;
      }
      case "pip": {
        // installing from pypi does not need the checkout.
        // Lots of stuff here, from the setting up synapse page.
        await actionsExec("mkdir", ["-p", "synapse"]);
        chdir("synapse");
        await actionsExec("python", ["-m", "venv", "env"]);
        await actionsExec("env/bin/pip", ["install", "-q", "--upgrade", "pip"]);
        await actionsExec("env/bin/pip", ["install", "-q", "--upgrade", "setuptools"]);
        await actionsExec("env/bin/pip", ["install", "-q", "matrix-synapse"]);
        break;
      }
      default: {
        setFailed("Valid installer option: poetry, pip");
      }
    }
    const customModules = getMultilineInput("customModules")
    for (let module of customModules) {
      switch (installer) {
        case "poetry": {
          await actionsExec("poetry", ["add", module]);
          break;
        }
        case "pip": {
          await actionsExec("env/bin/pip", ["install", "-q", module]);
          break;
        }
      }
    }

    // homeserver.yaml is the default server config from synapse
    info("Generating config...");
    switch (installer) {
      case "poetry": {
        await actionsExec("poetry", [
          "run", "python",
          "-m", "synapse.app.homeserver",
          "--server-name", "localhost",
          "--config-path", "homeserver.yaml",
          "--generate-config",
          "--report-stats=no"
        ]);
        break;
      }
      case "pip": {
        await actionsExec("env/bin/python3", [
          "-m", "synapse.app.homeserver",
          "--server-name", "localhost",
          "--config-path", "homeserver.yaml",
          "--generate-config",
          "--report-stats=no"
        ]);
        break;
      }
    }

    const port = getInput("httpPort");
    var publicBaseurl = getInput("publicBaseurl");
    if (publicBaseurl == "") {
      publicBaseurl = `http://localhost:${port}`
    }

    // Additional is our customizations to the base homeserver config
    var additional = {
      public_baseurl: publicBaseurl,
      enable_registration: true,
      enable_registration_without_verification: true,
      listeners: [
        {
          port: parseInt(port),
          tls: false,
          bind_addresses: ['0.0.0.0'],
          type: 'http',
          resources: [
            {
              names: ['client', 'federation'],
              compress: false
            }
          ]
        }
      ]
    };

    const disableRateLimiting = getBooleanInput("disableRateLimiting");
    if (disableRateLimiting) {
      const rateLimiting = {
        rc_message: {
          per_second: 1000,
          burst_count: 1000
        },
        rc_registration: {
          per_second: 1000,
          burst_count: 1000
        },
        rc_login: {
          address: {
            per_second: 1000,
            burst_count: 1000
          },
          account: {
            per_second: 1000,
            burst_count: 1000
          },
          failed_attempts: {
            per_second: 1000,
            burst_count: 1000
          }
        },
        rc_admin_redaction: {
          per_second: 1000,
          burst_count: 1000
        },
        rc_joins: {
          local: {
            per_second: 1000,
            burst_count: 1000
          },
          remote: {
            per_second: 1000,
            burst_count: 1000
          }
        },
        rc_3pid_validation: {
          per_second: 1000,
          burst_count: 1000
        },
        rc_invites: {
          per_room: {
            per_second: 1000,
            burst_count: 1000
          },
          per_user: {
            per_second: 1000,
            burst_count: 1000
          }
        }
      };
      additional = { ...additional, ...rateLimiting };
    }
    writeFile("additional.yaml", JSON.stringify(additional, null, 2), 'utf8', (err) => { if (err != null) { info(err); } });

    // And finally, customConfig is the user-supplied custom config, if required

    const customConfig = getInput("customConfig");
    writeFile("custom.yaml", customConfig, 'utf8', (err) => { if (err != null) { info(err); } });

    // Add listeners
    // Disable ratelimiting
    // etc

    // Ensure all files we pick up as logs afterwards are at least on disk
    await actionsExec("touch", [
      "out.log",
      "err.log",
      "homeserver.log",
      "homeserver.yaml",
      "additional.yaml",
      "custom.yaml"
    ]);

    info("Starting synapse");
    const out = openSync('out.log', 'a');
    const err = openSync('err.log', 'a');
    const options = {
      detached: true,
      stdio: ['ignore', out, err]
    }
    var child;
    switch (installer) {
      case "poetry": {
        child = spawn("poetry", [
          "run", "python",
          "-m", "synapse.app.homeserver",
          "--config-path", "homeserver.yaml",
          "--config-path", "additional.yaml",
          "--config-path", "custom.yaml"
        ], options);
        break;
      }
      case "pip": {
        child = spawn("env/bin/python3", [
          "-m", "synapse.app.homeserver",
          "--config-path", "homeserver.yaml",
          "--config-path", "additional.yaml",
          "--config-path", "custom.yaml"
        ], options);
        break;
      }
    }
    saveState("synapse-pid", child.pid);
    info("Waiting until C-S api is available");

    const url = `http://localhost:${port}/_matrix/client/versions`;
    var retry = 0;
    while (retry < 20) {
      info("Checking endpoint...");
      const response = await checkFor200(url);
      info(`... got ${response}`);
      if (response == 200) {
        break;
      }
      if (retry++ == 10) {
        setFailed("Unable to start synapse in 60s");
        break;
      }
      else {
        await sleep(6000);
        continue;
      }
    }

    // drop nodejs references to the synapse child process, so we can exit cleanly
    child.unref();

    // Action directory is not in the root; provide an output with the synapse folder we're using
    saveState("synapse-dir", cwd());
    setOutput("synapse-url", `http://localhost:${port}/`);
  } catch (error) {
    setFailed(error.message);
  }
}

// Short timeout because we have a larger retry loop around it
// And the server should respond within ~500ms or is generally unhappy anyway
async function checkFor200(target) {
  return new Promise((resolve) => {
    const req = get(target, { timeout: 500 }, (res) => {
      resolve(res.statusCode);
    }).on('timeout', () => {
      req.destroy();
      resolve(0);
    }).on('error', () => {
      resolve(0);
    });
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

run();
