/* Material touches that need JS: button ripples + ApexCharts global theme.
   No dependencies; loaded before dashboard.js so window.Apex is picked up. */
(function () {
  'use strict';

  // ---- ApexCharts global defaults (read by every `new ApexCharts(...)`) ----
  window.Apex = {
    // fallback categorical order (validated ramp steps); charts usually
    // pass their own quantile-coded colors via chartOptions
    colors: ['#2a78d6', '#1c5cab', '#86b6ef', '#984061', '#8c5000', '#006e1c'],
    chart: {
      fontFamily: 'Roboto, "Segoe UI", system-ui, sans-serif',
      foreColor: '#46464f',
    },
    grid: { borderColor: '#e3e1ec' },
    tooltip: { theme: 'light' },
  };

  // ---- collapsible sidebar (state persisted per browser) ----
  var layout = document.querySelector('.layout');
  var toggle = document.getElementById('sidebar-toggle');
  if (localStorage.getItem('sidebarMini') === '1') layout.classList.add('sidebar-mini');
  toggle.addEventListener('click', function () {
    var mini = layout.classList.toggle('sidebar-mini');
    localStorage.setItem('sidebarMini', mini ? '1' : '0');
    toggle.title = mini ? 'Expand sidebar' : 'Collapse sidebar';
    window.dispatchEvent(new Event('resize'));  // let ApexCharts reflow
  });

  // ---- ripple effect on Material interactive surfaces ----
  var RIPPLE_HOSTS = '.btn, .nav-item, .run-tab, .tab-add, .menu button, .sidebar-toggle';

  document.addEventListener('pointerdown', function (ev) {
    var host = ev.target.closest(RIPPLE_HOSTS);
    if (!host || host.disabled) return;

    var rect = host.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height);
    var ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (ev.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (ev.clientY - rect.top - size / 2) + 'px';
    host.appendChild(ripple);
    ripple.addEventListener('animationend', function () { ripple.remove(); });
  });
})();
