"""Emballe docker/threatmap_inputs en dist/threatmap_inputs.tgz, installe par docker-compose.yml."""
import io, os, tarfile

ICI = os.path.dirname(os.path.abspath(__file__))
APP = "threatmap_inputs"
SORTIE = os.path.join(ICI, "..", "dist", APP + ".tgz")

os.makedirs(os.path.dirname(SORTIE), exist_ok=True)
with tarfile.open(SORTIE, "w:gz") as tgz:
    for racine, _, fichiers in os.walk(os.path.join(ICI, APP)):
        for f in sorted(fichiers):
            chemin = os.path.join(racine, f)
            with open(chemin, "rb") as src:
                data = src.read().replace(b"\r\n", b"\n")
            info = tarfile.TarInfo(os.path.relpath(chemin, ICI).replace(os.sep, "/"))
            info.size, info.mode = len(data), 0o644
            tgz.addfile(info, io.BytesIO(data))
print("entrees       : dist/%s.tgz" % APP)
