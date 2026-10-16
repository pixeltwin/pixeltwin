// The clock in the header and the footer: different on every run, so the tests ignore it.
function tick() {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  for (const clock of document.querySelectorAll('.clock')) clock.textContent = now;
}
tick();
setInterval(tick, 1000);
