# East River snow profiles

Interactive figure of the paper *Leveraging probabilistic machine learning to enable large scale assimilation
of ICESat-2 snow depth observations* by Mazzolini, Aalstad, Cowherd, Alonso-González, Girotto and Treichler
(manuscript for Geoscientific Model Development): snow depth along two
profiles in the East River basin, Colorado, from the MuSA assimilation of ICESat-2 snow depth (GP and
Gaspari–Cohn prior correlations), compared with ASO lidar and three gridded snow products.

- **Site:** https://mmazzolini.github.io/eastriver-snow-viewer/
- **Code of the paper and of this page:** https://github.com/mmazzolini/eastriver-snow-paper (the page is `docs/` there;
  archived at https://doi.org/10.5281/zenodo.23914632)
- **Data record (Zenodo):** https://doi.org/10.5281/zenodo.23894419

This repository holds only the page. GitHub Actions (`.github/workflows/pages.yml`) publishes it
together with its data files, which are kept in a private repository.

ASO snow depth © Airborne Snow Observatories, Inc., shown for visualisation only; it is not part of
the data record and may not be redistributed. Gridded products: UA 800 m (University of Arizona;
Broxton et al. 2024), SNODAS (NOAA NOHRSC, NSIDC G02158), WLDAS (NASA GES DISC).

Licence: GPL-3.0 (as the paper code). The vendored `js/vendor/d3.v7.9.0.min.js` is ISC-licensed.
