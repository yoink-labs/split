import AppKit
let size=1024
let image=NSImage(size:NSSize(width:size,height:size))
image.lockFocus()
NSColor(calibratedRed:0.09,green:0.22,blue:0.17,alpha:1).setFill(); NSRect(x:0,y:0,width:size,height:size).fill()
let color=NSColor(calibratedRed:0.80,green:0.93,blue:0.53,alpha:1)
color.setFill()
let top=NSBezierPath(roundedRect:NSRect(x:232,y:542,width:560,height:142),xRadius:71,yRadius:71)
top.fill()
let bottom=NSBezierPath(roundedRect:NSRect(x:232,y:340,width:560,height:142),xRadius:71,yRadius:71)
bottom.fill()
NSColor(calibratedRed:0.09,green:0.22,blue:0.17,alpha:1).setFill()
let slash=NSBezierPath();slash.move(to:NSPoint(x:500,y:280));slash.line(to:NSPoint(x:638,y:280));slash.line(to:NSPoint(x:524,y:744));slash.line(to:NSPoint(x:386,y:744));slash.close();slash.fill()
image.unlockFocus()
let bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!
try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:"Split/Resources/Assets.xcassets/AppIcon.appiconset/icon.png"))
