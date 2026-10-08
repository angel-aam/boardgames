#!/usr/bin/env python3
"""Uso: python3 minify.py <fichero.html> [directorio_salida]

Minifica un HTML (sin dependencias, solo librería estándar de Python)
y lo guarda como index.html.
"""
import re
import sys
from pathlib import Path

# Bloques cuyo contenido no se debe tocar con las reglas de HTML
PROTEGIDOS = re.compile(
    r"(<pre\b.*?</pre>|<textarea\b.*?</textarea>|<script\b.*?</script>|<style\b.*?</style>)",
    re.IGNORECASE | re.DOTALL,
)

# Etiquetas de bloque: el espacio alrededor no afecta al renderizado
BLOQUE = re.compile(
    r"\s*(</?(?:!doctype|html|head|body|meta|link|title|base|div|p|ul|ol|li|h[1-6]|"
    r"section|article|header|footer|nav|main|aside|table|thead|tbody|tfoot|tr|td|th|"
    r"form|fieldset|br|hr|script|style)\b[^>]*>)\s*",
    re.IGNORECASE,
)


def minificar_css(css: str) -> str:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)
    css = re.sub(r"\s+", " ", css)
    css = re.sub(r"\s*([{};,>])\s*", r"\1", css)
    css = re.sub(r":\s+", ":", css)
    css = css.replace(";}", "}")
    return css.strip()


def procesar_style(bloque: str) -> str:
    m = re.match(r"(<style\b[^>]*>)(.*?)(</style>)", bloque, re.IGNORECASE | re.DOTALL)
    if not m:
        return bloque
    return m.group(1) + minificar_css(m.group(2)) + m.group(3)


def procesar_html(trozo: str) -> str:
    trozo = re.sub(r"<!--(?!\[if|<!\[endif).*?-->", "", trozo, flags=re.DOTALL)
    trozo = re.sub(r"\s+", " ", trozo)
    trozo = BLOQUE.sub(r"\1", trozo)
    return trozo


def minificar(html: str) -> str:
    partes = PROTEGIDOS.split(html)
    salida = []
    for i, parte in enumerate(partes):
        if i % 2 == 0:  # HTML normal
            salida.append(procesar_html(parte))
        elif parte.lower().startswith("<style"):
            salida.append(procesar_style(parte))
        else:  # pre, textarea, script: se dejan tal cual
            salida.append(parte)
    return "".join(salida).strip()


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("Uso: python3 minify.py <fichero.html> [directorio_salida]")

    entrada = Path(sys.argv[1])
    destino_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(".")
    salida = destino_dir / "index.html"

    if not entrada.is_file():
        sys.exit(f"No existe el fichero: {entrada}")
    if entrada.resolve() == salida.resolve():
        sys.exit("La entrada es el mismo index.html de destino; indica otro directorio de salida.")

    original = entrada.read_text(encoding="utf-8")
    resultado = minificar(original)

    destino_dir.mkdir(parents=True, exist_ok=True)
    salida.write_text(resultado, encoding="utf-8")

    antes, despues = len(original.encode()), len(resultado.encode())
    ahorro = (antes - despues) / antes * 100 if antes else 0
    print(f"{entrada} -> {salida}: {antes} B -> {despues} B (-{ahorro:.1f}%)")


if __name__ == "__main__":
    main()
