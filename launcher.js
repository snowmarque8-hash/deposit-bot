// launcher.js — runs BOTH bots in one Railway service
// Place this at the ROOT of your repo (right next to bot.js)
const { spawn } = require('child_process');
const path = require('path');

function run(name, file, cwd) {
  console.log(`▶ Starting ${name}...`);
  const child = spawn('node', [file], { cwd, stdio: 'inherit' });
  child.on('exit', code => {
    console.log(`⚠ ${name} stopped (code ${code}). Restarting in 5s...`);
    setTimeout(() => run(name, file, cwd), 5000);
  });
}

// Deposit bot (lives at repo root)
run('Deposit Bot', 'bot.js', __dirname);

// Resell bot (lives in the resell-bot subfolder)
run('Resell Bot', 'index.js', path.join(__dirname, 'resell-bot'));
