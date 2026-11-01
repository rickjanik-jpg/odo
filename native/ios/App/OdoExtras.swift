import Foundation
import UIKit
import MapKit
import Capacitor

/// Backup sharing and Apple Maps route pictures for the app screens.
extension OdoTrackerPlugin {

    /// Writes text to a file and opens the share sheet (Save to Files, iCloud Drive, AirDrop, Mail...).
    /// Resolves with { completed: true/false }.
    @objc func shareFile(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let text = call.getString("text") else {
            call.reject("name and text are required")
            return
        }
        let safe = name.replacingOccurrences(of: "/", with: "-")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(safe)
        do {
            try text.data(using: .utf8)?.write(to: url, options: .atomic)
        } catch {
            call.reject("Couldn't create the backup file")
            return
        }
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else {
                call.reject("Couldn't open the share sheet")
                return
            }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            sheet.completionWithItemsHandler = { activity, completed, _, error in
                try? FileManager.default.removeItem(at: url)
                if let error = error {
                    call.reject(error.localizedDescription)
                } else {
                    call.resolve(["completed": completed, "activity": activity?.rawValue ?? ""])
                }
            }
            if let pop = sheet.popoverPresentationController { // iPad
                pop.sourceView = vc.view
                pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.maxY - 80, width: 1, height: 1)
            }
            vc.present(sheet, animated: true)
        }
    }

    /// Draws a trip's route on an Apple Maps picture. Resolves with { image: "data:image/jpeg;base64,..." }.
    @objc func mapSnapshot(_ call: CAPPluginCall) {
        // The route arrives as JSON text: [[lat, lng], ...]
        guard let json = call.getString("path"), let data = json.data(using: .utf8),
              let raw = (try? JSONSerialization.jsonObject(with: data)) as? [[Double]] else {
            call.reject("A route needs at least two points")
            return
        }
        let coords: [CLLocationCoordinate2D] = raw.compactMap { p in
            p.count >= 2 ? CLLocationCoordinate2D(latitude: p[0], longitude: p[1]) : nil
        }
        guard coords.count >= 2 else { call.reject("A route needs at least two points"); return }
        let width = CGFloat(call.getDouble("width") ?? 340)
        let height = CGFloat(call.getDouble("height") ?? 220)
        let dark = call.getBool("dark") ?? false

        DispatchQueue.main.async {
            var rect = MKMapRect.null
            for c in coords {
                let p = MKMapPoint(c)
                rect = rect.union(MKMapRect(x: p.x, y: p.y, width: 0, height: 0))
            }
            // Leave room around the route, and never zoom in closer than a few blocks.
            let minSide = MKMapPointsPerMeterAtLatitude(coords[0].latitude) * 400
            let w = max(rect.width, minSide), h = max(rect.height, minSide)
            rect = MKMapRect(x: rect.midX - w / 2, y: rect.midY - h / 2, width: w, height: h)

            let options = MKMapSnapshotter.Options()
            options.mapRect = rect
            options.size = CGSize(width: width, height: height)
            options.traitCollection = UITraitCollection(traitsFrom: [
                UITraitCollection(displayScale: UIScreen.main.scale),
                UITraitCollection(userInterfaceStyle: dark ? .dark : .light),
            ])
            options.pointOfInterestFilter = .excludingAll
            let fitted = MKMapView().mapRectThatFits(rect, edgePadding: UIEdgeInsets(top: 28, left: 28, bottom: 28, right: 28))
            options.mapRect = fitted

            MKMapSnapshotter(options: options).start(with: .global(qos: .userInitiated)) { snap, error in
                guard let snap = snap else {
                    call.reject(error?.localizedDescription ?? "Map unavailable")
                    return
                }
                let accent = dark ? UIColor(red: 0.24, green: 0.81, blue: 0.56, alpha: 1)
                                  : UIColor(red: 0.12, green: 0.54, blue: 0.36, alpha: 1)
                let format = UIGraphicsImageRendererFormat()
                format.scale = snap.image.scale
                let img = UIGraphicsImageRenderer(size: snap.image.size, format: format).image { ctx in
                    snap.image.draw(at: .zero)
                    let g = ctx.cgContext
                    let pts = coords.map { snap.point(for: $0) }
                    g.setLineCap(.round)
                    g.setLineJoin(.round)
                    // White casing under the line so it reads on any map color.
                    for (lineWidth, color) in [(CGFloat(7), UIColor.white.withAlphaComponent(0.9)), (CGFloat(4.5), accent)] {
                        g.setLineWidth(lineWidth)
                        g.setStrokeColor(color.cgColor)
                        g.beginPath()
                        g.move(to: pts[0])
                        for p in pts.dropFirst() { g.addLine(to: p) }
                        g.strokePath()
                    }
                    func dot(_ p: CGPoint, fill: UIColor) {
                        let r: CGFloat = 6
                        let box = CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)
                        g.setFillColor(fill.cgColor)
                        g.fillEllipse(in: box)
                        g.setStrokeColor(accent.cgColor)
                        g.setLineWidth(3)
                        g.strokeEllipse(in: box)
                    }
                    dot(pts[0], fill: .white)
                    dot(pts[pts.count - 1], fill: accent)
                }
                guard let data = img.jpegData(compressionQuality: 0.85) else {
                    call.reject("Map unavailable")
                    return
                }
                call.resolve(["image": "data:image/jpeg;base64," + data.base64EncodedString()])
            }
        }
    }
}
