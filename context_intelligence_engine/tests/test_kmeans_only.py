import pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent


def test_only_kmeans_is_used_for_clustering():
    banned = re.compile(r"HDBSCAN|DBSCAN|Agglomerative|AffinityPropagation|MiniBatchKMeans|GaussianMixture|Birch|SpectralClustering|OPTICS|MeanShift", re.I)
    for f in list((ROOT / "cie").glob("*.py")) + list((ROOT / "cie" / "adapters").glob("*.py")):
        for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            assert not banned.search(line) or "only clustering algorithm" in line, (f.name, i, line)
