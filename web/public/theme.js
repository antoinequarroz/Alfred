// Applique le thème choisi avant le premier affichage (évite un flash).
(function () {
  try {
    var t = localStorage.getItem('alfred:theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) {}
})();
