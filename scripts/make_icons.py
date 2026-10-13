"""生成 SealPack 应用图标（PNG / ICO / ICNS）。"""

import os
from PIL import Image, ImageDraw

OUT = r"D:/Codespace/SealPack/src-tauri/icons"
S = 1024

BG = (15, 23, 42, 255)        # slate-900
GOLD = (245, 179, 1, 255)     # 琥珀金
GOLD_DK = (214, 150, 0, 255)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def build():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # 圆角底板
    plate = Image.new("RGBA", (S, S), BG)
    img.paste(plate, (0, 0), rounded_mask(S, int(S * 0.22)))

    d = ImageDraw.Draw(img)

    # 盾牌外形
    shield = [
        (300, 262), (724, 262), (724, 556), (512, 828), (300, 556),
    ]
    d.polygon(shield, fill=GOLD)

    # 盾牌顶部高光边
    d.polygon([(300, 262), (724, 262), (724, 330), (300, 330)], fill=(255, 205, 80, 255))

    # 钥匙孔（挖空，露出底板色）
    d.ellipse([452, 396, 572, 516], fill=BG)
    d.polygon([(486, 486), (538, 486), (556, 626), (468, 626)], fill=BG)

    # 两侧封条
    d.rounded_rectangle([196, 470, 262, 690], radius=33, fill=GOLD_DK)
    d.rounded_rectangle([762, 470, 828, 690], radius=33, fill=GOLD_DK)

    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    icon = build()

    icon.resize((32, 32), Image.LANCZOS).save(os.path.join(OUT, "32x32.png"))
    icon.resize((128, 128), Image.LANCZOS).save(os.path.join(OUT, "128x128.png"))
    icon.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "128x128@2x.png"))
    icon.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon.png"))
    icon.resize((30, 30), Image.LANCZOS).save(os.path.join(OUT, "Square30x30Logo.png"))
    icon.resize((44, 44), Image.LANCZOS).save(os.path.join(OUT, "Square44x44Logo.png"))
    icon.resize((71, 71), Image.LANCZOS).save(os.path.join(OUT, "Square71x71Logo.png"))
    icon.resize((89, 89), Image.LANCZOS).save(os.path.join(OUT, "Square89x89Logo.png"))
    icon.resize((107, 107), Image.LANCZOS).save(os.path.join(OUT, "Square107x107Logo.png"))
    icon.resize((142, 142), Image.LANCZOS).save(os.path.join(OUT, "Square142x142Logo.png"))
    icon.resize((150, 150), Image.LANCZOS).save(os.path.join(OUT, "Square150x150Logo.png"))
    icon.resize((284, 284), Image.LANCZOS).save(os.path.join(OUT, "Square284x284Logo.png"))
    icon.resize((310, 310), Image.LANCZOS).save(os.path.join(OUT, "Square310x310Logo.png"))
    icon.resize((50, 50), Image.LANCZOS).save(os.path.join(OUT, "StoreLogo.png"))

    icon.save(
        os.path.join(OUT, "icon.ico"),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    try:
        icon.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon.icns"))
        print("icns ok")
    except Exception as exc:  # noqa: BLE001
        print("icns skipped:", exc)

    print("icons written to", OUT)


if __name__ == "__main__":
    main()
