import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
// Original Split mark: equality bars shared across a diagonal cut.
// Opaque, full-bleed 1024px art; iOS supplies the icon mask.
let root="Split/Resources/Assets.xcassets"
let variants:[(String,[CGFloat],[CGFloat])] = [
 ("icon.png",[0.82,0.94,0.57,1],[0.07,0.22,0.17,1]),
 ("icon-dark.png",[0.045,0.085,0.07,1],[0.82,0.94,0.57,1]),
 ("icon-tinted.png",[0.06,0.06,0.06,1],[0.94,0.94,0.94,1])]
for (filename,bg,fg) in variants {
 let space=CGColorSpace(name:CGColorSpace.sRGB)!
 let context=CGContext(data:nil,width:1024,height:1024,bitsPerComponent:8,bytesPerRow:4096,space:space,bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue)!
 context.setFillColor(CGColor(colorSpace:space,components:bg)!); context.fill(CGRect(x:0,y:0,width:1024,height:1024))
 context.setFillColor(CGColor(colorSpace:space,components:fg)!)
 for y in [CGFloat(542),CGFloat(340)] { context.addPath(CGPath(roundedRect:CGRect(x:222,y:y,width:580,height:142),cornerWidth:71,cornerHeight:71,transform:nil));context.fillPath() }
 context.setFillColor(CGColor(colorSpace:space,components:bg)!)
 context.beginPath();context.move(to:CGPoint(x:518,y:280));context.addLine(to:CGPoint(x:622,y:280));context.addLine(to:CGPoint(x:506,y:744));context.addLine(to:CGPoint(x:402,y:744));context.closePath()
 // Distinct diagonal channel, optically centered on the two shared bars.
 context.fillPath()
 let image=context.makeImage()!
 let url=URL(fileURLWithPath:"\(root)/AppIcon.appiconset/\(filename)")
 let destination=CGImageDestinationCreateWithURL(url as CFURL,UTType.png.identifier as CFString,1,nil)!
 CGImageDestinationAddImage(destination,image,nil); precondition(CGImageDestinationFinalize(destination))
}
