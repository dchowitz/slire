const { spawn } = require('child_process');
const net = require('net');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

const requiredPorts = [8080, 4400]; // firestore, hub (default ports)
let emulatorProcess = null;

async function startEmulator() {
  console.log('🔥 Starting Firestore emulator...');
  console.log(
    `🔍 Checking if ports ${requiredPorts.join(', ')} are available...`,
  );

  const portsInUse = await getPortsInUse();
  if (portsInUse.length > 0) {
    throw new Error(`Ports already in use: ${portsInUse.join(', ')} `);
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
      detached: process.platform !== 'win32', // Create new process group on Unix
      cwd: __dirname, // Ensure we're in the right directory to find package.json
    },
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
  if (!emulatorProcess) {
    console.log('ℹ️  No emulator process to stop');
  }

  console.log(
    `🛑 Stopping Firestore emulator (PID: ${emulatorProcess.pid})...`,
  );

  // Check if process is actually running
  try {
    process.kill(emulatorProcess.pid, 0); // Test if process exists
    console.log('✓ Emulator process is running, attempting to stop...');
  } catch {
    console.log('✓ Emulator process already terminated');
    emulatorProcess = null;
    return;
  }

  // Kill entire process tree (parent + all children like hub)
  console.log('🔪 Killing Firebase emulator process tree...');
  await killProcessTree(emulatorProcess.pid);

  console.log('⏳ Waiting for process tree cleanup...');
  await sleep(3000);

  // Verify main process is dead
  let mainProcessDead;
  try {
    process.kill(emulatorProcess.pid, 0);
    mainProcessDead = false;
  } catch {
    mainProcessDead = true;
  }

  if (mainProcessDead) {
    console.log('✅ Firebase emulator process tree stopped');
  } else {
    console.log('⚠️  Main process still running, attempting direct kill...');
    try {
      emulatorProcess.kill('SIGKILL');
      await sleep(1000);
    } catch (error) {
      console.log(`Direct kill completed: ${error.message}`);
    }
  }

  emulatorProcess = null;

  // Extra cleanup: ensure ports are freed
  console.log('⏳ Waiting for ports to be released...');
  await sleep(2000);

  // Verify ports are actually free
  const portsStillInUse = await getPortsInUse();

  if (portsStillInUse.length > 0) {
    console.warn(
      `⚠️  Ports still in use after cleanup: ${portsStillInUse.join(', ')}`,
    );
  } else {
    console.log('✅ All ports successfully released');
  }

  console.log('✅ Firestore emulator cleanup completed');
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

async function killProcessTree(pid) {
  if (process.platform === 'win32') {
    // Windows: Use taskkill to kill process tree
    spawn('taskkill', ['/pid', pid, '/t', '/f'], { stdio: 'ignore' });
  } else {
    // Unix: Kill process group (all child processes)
    try {
      process.kill(-pid, 'SIGTERM'); // Negative PID = entire process group
      await sleep(2000);
      process.kill(-pid, 'SIGKILL'); // Force kill if still running
    } catch (error) {
      // Process might already be dead, that's okay
      console.log(`Process group kill completed (${error.message})`);
    }
  }
}

async function getPortsInUse() {
  const ports = await Promise.all(requiredPorts.map((p) => isPortInUse(p)));
  return ports.reduce(
    (res, inUse, idx) => (inUse ? [...res, requiredPorts[idx]] : res),
    [],
  );
}

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
