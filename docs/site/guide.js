const menu = document.querySelector('#menu-toggle');
const sidebar = document.querySelector('.sidebar');
const scrim = document.querySelector('.nav-scrim');
function closeMenu() {
  sidebar.classList.remove('open');
  menu.setAttribute('aria-expanded', 'false');
  scrim.hidden = true;
}
menu.addEventListener('click', () => {
  const open = !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  menu.setAttribute('aria-expanded', String(open));
  scrim.hidden = !open;
});
scrim.addEventListener('click', closeMenu);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});
const links = [...document.querySelectorAll('#chapter-nav > a')];
links.forEach((link) => link.addEventListener('click', closeMenu));

const sections = [...document.querySelectorAll('main > section[id]')];
const progress = document.querySelector('.reading-progress span');
let scheduled = false;
function updateReading() {
  const section =
    sections.filter((s) => s.getBoundingClientRect().top <= 150).at(-1) ?? sections[0];
  for (const link of links) {
    const current = link.hash === '#' + section.id;
    link.classList.toggle('active', current);
    if (current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
  const remaining = document.documentElement.scrollHeight - innerHeight;
  progress.style.width = remaining ? Math.min(100, (scrollY / remaining) * 100) + '%' : '0%';
  scheduled = false;
}
addEventListener(
  'scroll',
  () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(updateReading);
    }
  },
  { passive: true },
);
addEventListener('resize', () => {
  if (innerWidth > 850) closeMenu();
  updateReading();
});
updateReading();

const status = document.querySelector('#copy-status');
let statusTimer;
document.querySelectorAll('.copy-code').forEach((button) => {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(
        button.closest('.code-block').querySelector('code').textContent,
      );
      status.textContent = '配置示例已复制';
    } catch {
      status.textContent = '复制失败，请选中示例手动复制';
    }
    status.classList.add('visible');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => status.classList.remove('visible'), 2300);
  });
});

const viewer = document.querySelector('#image-viewer');
document.querySelectorAll('.screenshot-open').forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    const image = viewer.querySelector('img');
    image.src = link.href;
    image.alt = link.querySelector('img').alt;
    viewer.querySelector('.viewer-original').href = link.href;
    viewer.showModal();
  });
});
viewer.querySelector('.viewer-close').addEventListener('click', () => viewer.close());
viewer.addEventListener('click', (event) => {
  if (event.target === viewer) viewer.close();
});
