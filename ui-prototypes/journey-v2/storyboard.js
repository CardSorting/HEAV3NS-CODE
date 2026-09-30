(() => {
  'use strict';
  const grid = document.getElementById('story-grid');
  for (const screen of window.JOURNEY_DATA) {
    const link = document.createElement('a');
    link.className = 'story';
    link.href = 'index.html#' + screen.id;
    const image = document.createElement('img');
    image.src = screen.file;
    image.alt = screen.title + ': ' + screen.goal;
    image.width = 1586;
    image.height = 992;
    image.loading = screen.n <= 3 ? 'eager' : 'lazy';
    const title = document.createElement('h2');
    const number = document.createElement('span');
    number.className = 'step-num';
    number.textContent = String(screen.n).padStart(2, '0');
    const name = document.createElement('span');
    name.textContent = screen.title;
    title.append(number, name);
    const phase = document.createElement('p');
    phase.className = 'phase-label';
    phase.textContent = screen.phase;
    const description = document.createElement('p');
    description.textContent = screen.goal;
    link.append(image, title, description, phase);
    grid.append(link);
  }
})();
