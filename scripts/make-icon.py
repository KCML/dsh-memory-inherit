"""生成插件图标：256×256 的圆角方块，深蓝到浅蓝渐变，上面一只白色鲸鱼 + 三条记忆线。"""

import math
from PIL import Image, ImageDraw

S = 1024  # 超采样，最后缩到 256
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# --- 渐变背景（圆角方块）---
grad = Image.new("RGB", (1, S))
top = (0x46, 0x46, 0x66)     # 深蓝
bottom = (0x80, 0xA0, 0xD0)  # 浅蓝
for y in range(S):
    t = y / (S - 1)
    grad.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
grad = grad.resize((S, S))

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=230, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)

WHITE = (242, 246, 255, 255)
INK = (0x2A, 0x35, 0x50, 255)
ACCENT = (0x60, 0x70, 0xB0, 255)

# --- 鲸鱼身体 ---
d.ellipse([210, 400, 760, 760], fill=WHITE)          # 身体
d.ellipse([150, 470, 430, 730], fill=WHITE)          # 头

# --- 尾鳍 ---
d.polygon([(735, 540), (900, 420), (880, 600), (735, 620)], fill=WHITE)
d.polygon([(735, 610), (890, 700), (860, 800), (735, 690)], fill=WHITE)

# --- 胸鳍 ---
d.polygon([(430, 690), (560, 790), (470, 820), (360, 740)], fill=WHITE)

# --- 眼睛 ---
d.ellipse([282, 540, 338, 596], fill=INK)
d.ellipse([296, 552, 316, 572], fill=(255, 255, 255, 255))

# --- 头顶喷水（三条小弧）---
for i, x in enumerate((330, 390, 450)):
    r = 26 + i * 4
    d.arc([x - r, 330 - r, x + r, 330 + r], start=200, end=340, fill=WHITE, width=18)

# --- 身体上的三条「记忆」线 ---
for i, w in enumerate((210, 170, 120)):
    y = 660 + i * 40
    d.rounded_rectangle([430, y, 430 + w, y + 18], radius=9, fill=ACCENT)

icon = img.resize((256, 256), Image.LANCZOS)
icon.save("icon.png")
print("saved", icon.size)
