// mockup only: ?logo=<file name in img/logos, without .png> swaps the banner logo
const logoName = new URLSearchParams(window.location.search).get("logo");

if (logoName && /^[a-z0-9-]+$/.test(logoName)) {
    const logo = document.querySelector(".site-banner__logo");

    logo.src = `img/logos/${logoName}.png`;
    logo.alt = "OHAZ and University of Oregon";
    logo.classList.add("site-banner__logo--wide");
}

// mockup only: ?layout=logo-right puts the title and settings on the left and the logo on the right
if (new URLSearchParams(window.location.search).get("layout") === "logo-right") {
    document.querySelector(".site-banner").classList.add("site-banner--logo-right");
}
