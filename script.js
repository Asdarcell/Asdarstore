document.addEventListener('DOMContentLoaded', function() {
    // Ambil elemen-elemen yang kita butuhkan dari HTML
    const drawerToggleBtn = document.querySelector('.drawer-toggle-btn');
    const drawerMenu = document.querySelector('.drawer-menu');
    const overlay = document.querySelector('.overlay');

    // Fungsi untuk membuka/menutup menu
    function toggleDrawer() {
        drawerMenu.classList.toggle('active');
        overlay.classList.toggle('active');
    }

    // Tambahkan event listener pada tombol menu
    if (drawerToggleBtn) {
        drawerToggleBtn.addEventListener('click', function(event) {
            event.stopPropagation(); // Mencegah klik menyebar ke elemen lain
            toggleDrawer();
        });
    }

    // Tambahkan event listener pada overlay untuk menutup menu
    if (overlay) {
        overlay.addEventListener('click', function() {
            toggleDrawer();
        });
    }
});
