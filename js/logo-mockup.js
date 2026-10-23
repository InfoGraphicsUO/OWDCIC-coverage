// mockup only: ?logo=<file name in img/logos, without .png> swaps the banner logo
const logoName = new URLSearchParams(window.location.search).get("logo");

if (logoName && /^[a-z0-9-]+$/.test(logoName)) {
    const logo = document.querySelector(".site-banner__logo");

    logo.src = `img/logos/${logoName}.png`;
    logo.alt = "OHAZ and University of Oregon";
    logo.classList.add("site-banner__logo--wide");
}
