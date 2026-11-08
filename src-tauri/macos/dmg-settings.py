# dmgbuild settings for the AliasMode disk image. The Mac workflow passes the
# app bundle and the background with -D; dmgbuild finds the @2x background
# next to the 1x file.
files = [defines["app"]]
symlinks = {"Applications": "/Applications"}
hide_extensions = ["猫步·千境.app"]
format = "UDZO"
filesystem = "HFS+"
background = defines["background"]
window_rect = ((360, 360), (660, 400))
default_view = "icon-view"
icon_size = 128
text_size = 13
icon_locations = {"猫步·千境.app": (180, 185), "Applications": (480, 185)}
