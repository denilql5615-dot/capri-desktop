"""Generate the Windows app, installer and tray icons from one geometric mark."""
from pathlib import Path

from PIL import Image, ImageDraw


def render(tray=False):
    size = 1024
    image = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((32, 32, 992, 992), radius=220, fill="#141518",
                           outline="#55565c", width=24)
    if not tray:
        for x, y in [(213, 213), (276, 213), (213, 276), (811, 748), (811, 811), (748, 811)]:
            draw.ellipse((x - 14, y - 14, x + 14, y + 14), fill="#71727a")

    # Angular G. Its open corner leaves space for the red signal.
    draw.polygon([(711, 256), (439, 256), (258, 437), (258, 614),
                  (429, 785), (707, 785), (779, 713), (779, 489),
                  (530, 489), (530, 598), (661, 598), (661, 667),
                  (478, 667), (376, 565), (376, 486), (488, 374),
                  (711, 374)], fill="#f1f1f2")
    draw.ellipse((756, 246, 882, 372), fill="#ff525d")
    return image


if __name__ == "__main__":
    output = Path(__file__).resolve().parents[1] / "assets" / "icons"
    render().resize((256, 256), Image.Resampling.LANCZOS).save(output / "capri.png")
    render().save(output / "capri.ico", sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
    render(tray=True).resize((32, 32), Image.Resampling.LANCZOS).save(output / "tray.png")
