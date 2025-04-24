import { info, getState, warning, error as actionErrorMessage, getBooleanInput, getInput } from '@actions/core';
import { kill } from 'process';
import { DefaultArtifactClient } from '@actions/artifact';

// most @actions toolkit packages have async methods
async function run() {
  info("Destroying synapse");
  var pid = getState("synapse-pid");
  var cwd = getState("synapse-dir");
  // Polite termination is for those without pull requests to merge.
  try {
    kill(pid, 15);
    await sleep(10000);
    try {
      kill(pid, 9);
      warning("Synapse did not shutdown in 10s! Terminating!");
    } catch (e) {
      // expected that synapse PID is not available to be terminated here.
    }
  } catch (e) {
    actionErrorMessage("Synapse is not running at teardown time!")
    actionErrorMessage(e.message)
  }

  try {
    // Tidy up the synapse directory to contain only log files
    // (useful for an artifact upload)
    const upload = getBooleanInput('uploadLogs');
    if (upload) {
      const artifactName = getInput('artifactName');
      const artifactClient = new DefaultArtifactClient();
      const files = [
        `${cwd}/homeserver.yaml`,
        `${cwd}/homeserver.log`,
        `${cwd}/custom.yaml`,
        `${cwd}/additional.yaml`,
        `${cwd}/out.log`,
        `${cwd}/err.log`
      ];

      const rootDirectory = `${cwd}`;
      const options = {
        retentionDays: parseInt(getInput("artifactRetentionDays"))
      }
      await artifactClient.uploadArtifact(artifactName, files, rootDirectory, options);
    }
  } catch (e) {
    actionErrorMessage(e.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}


run();
