// launcher.js — runs BOTH bots in one Railway service
// Place this at the ROOT of your repo (right next to bot.js)
const { fork } = require('child_process');
const path = require('path');

function run(name, file, cwd) {
  console.log(`▶ Starting ${name}...`);
  // fork() reuses the same Node binary that's already running — no PATH lookup needed
  const child = fork(file, [], { cwd, stdio: 'inherit' });
  child.on('exit', code => {
    console.log(`⚠ ${name} stopped (code ${code}). Restarting in 5s...`);
    setTimeout(() => run(name, file, cwd), 5000);
  });
  child.on('error', err => {
    console.log(`⚠ ${name} failed to start: ${err.message}`);
  });
}

// Deposit bot (lives at repo root)
run('Deposit Bot', path.join(__dirname, 'bot.js'), __dirname);

// Resell bot (lives in the resell-bot subfolder)
run('Resell Bot', path.join(__dirname, 'resell-bot', 'index.js'), path.join(__dirname, 'resell-bot'));
