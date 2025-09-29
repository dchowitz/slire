const { spawn } = require('child_process');
const net = require('net');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

// Port checking utility
async function isPortInUse(port, host = 'localhost') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, host, () => {
      server.once('close', () => {
        resolve(false); // Port is free
      });
      server.close();
    });
    server.on('error', () => {
      resolve(true); // Port is in use
    });
  });
}

/**
 * Jest Global Setup for Firestore Emulator
 *
 * This automatically starts/stops the Firestore emulator for testing.
 *
 * Requirements:
 * - firebase-tools in devDependencies (in root package.json for Nx monorepo)
 * - Java 8+ installed (for Firestore emulator)
 *
 * CI Usage (GitHub Actions):
 * ```yaml
 * - uses: actions/setup-node@v4
 * - uses: actions/setup-java@v4
 *   with:
 *     java-version: '11'
 * - run: npm ci  # Installs firebase-tools from root package.json
 * - run: npx nx test smart-repo
 * ```
 */

let emulatorProcess = null;

async function startEmulator() {
  console.log('🔥 Starting Firestore emulator...');

  // Check if required ports are available
  const requiredPorts = [8080, 4400]; // firestore, hub (default ports)
  console.log(
    `🔍 Checking if ports ${requiredPorts.join(', ')} are available...`
  );

  for (const port of requiredPorts) {
    if (await isPortInUse(port)) {
      throw new Error(
        `Port ${port} is already in use. This might be from a previous test run that didn't clean up properly. ` +
          `Try waiting a moment and running again, or check for lingering Firebase processes.`
      );
    }
  }

  console.log('✅ All required ports are available');

  // Use npx to run local firebase-tools from devDependencies
  // This ensures we use the version specified in package.json
  emulatorProcess = spawn(
    'npx',
    [
      'firebase',
      'emulators:start',
      '--only=firestore',
      '--project=smart-repo-test',
    ],
    {
      stdio: 'pipe',
      detached: false,
      cwd: __dirname, // Ensure we're in the right directory to find package.json
    }
  );

  // Wait for emulator to be ready
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Firestore emulator failed to start within 30 seconds'));
    }, 30000);

    emulatorProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`Emulator: ${output}`);

      // Look for the ready message
      if (output.includes('All emulators ready')) {
        clearTimeout(timeout);
        console.log('✅ Firestore emulator is ready!');
        resolve();
      }
    });

    emulatorProcess.stderr.on('data', (data) => {
      console.error(`Emulator error: ${data}`);
    });

    emulatorProcess.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    emulatorProcess.on('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Emulator process exited with code ${code}`));
      }
    });
  });
}

async function stopEmulator() {
  if (emulatorProcess) {
    console.log(
      `🛑 Stopping Firestore emulator (PID: ${emulatorProcess.pid})...`
    );

    // Check if process is actually running
    try {
      process.kill(emulatorProcess.pid, 0); // Test if process exists
      console.log('✓ Emulator process is running, attempting to stop...');
    } catch (error) {
      console.log('✓ Emulator process already terminated');
      emulatorProcess = null;
      return;
    }

    // Try graceful shutdown first
    console.log('📤 Sending SIGTERM to emulator...');
    emulatorProcess.kill('SIGTERM');

    // Wait a bit for graceful shutdown
    console.log('⏳ Waiting 3 seconds for graceful shutdown...');
    await sleep(3000);

    // Check if still running
    let stillRunning = false;
    try {
      process.kill(emulatorProcess.pid, 0);
      stillRunning = true;
    } catch (error) {
      stillRunning = false;
    }

    if (stillRunning) {
      console.log(
        '⚠️  Graceful shutdown failed, force killing emulator process'
      );
      emulatorProcess.kill('SIGKILL');

      // Wait for force kill to take effect
      await sleep(1000);

      // Final check
      try {
        process.kill(emulatorProcess.pid, 0);
        console.error(
          '❌ CRITICAL: Emulator process still running after SIGKILL!'
        );
      } catch (error) {
        console.log('✅ Emulator process successfully force killed');
      }
    } else {
      console.log('✅ Emulator process stopped gracefully');
    }

    emulatorProcess = null;

    // Extra cleanup: ensure ports are freed
    console.log('⏳ Waiting for ports to be released...');
    await sleep(2000);

    // Verify ports are actually free
    const portsStillInUse = [];
    for (const port of [8080, 9080, 4400, 4401, 4402]) {
      if (await isPortInUse(port)) {
        portsStillInUse.push(port);
      }
    }

    if (portsStillInUse.length > 0) {
      console.warn(
        `⚠️  Ports still in use after cleanup: ${portsStillInUse.join(', ')}`
      );
    } else {
      console.log('✅ All ports successfully released');
    }

    console.log('✅ Firestore emulator cleanup completed');
  } else {
    console.log('ℹ️  No emulator process to stop');
  }
}

// Jest global setup
module.exports = async () => {
  try {
    await startEmulator();
    // Store the cleanup function globally
    global.__EMULATOR_CLEANUP__ = stopEmulator;
  } catch (error) {
    console.error('❌ Failed to start Firestore emulator:', error.message);
    throw error;
  }
};
