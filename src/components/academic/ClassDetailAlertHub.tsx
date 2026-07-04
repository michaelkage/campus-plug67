import { useState } from 'react';
import { Book, MapPin, Bell } from 'lucide-react';

export default function ClassDetailAlertHub() {
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="bg-obsidian-400 p-6 rounded-xl border border-obsidian-500">
        <h1 className="text-2xl font-black text-white flex items-center gap-3">
          <Book className="text-plug-green" /> CSC 301: Data Structures
        </h1>
        <div className="flex items-center gap-2 mt-2 text-white/60 text-sm">
          <MapPin size={14} /> LT1, Faculty of Science
        </div>
        <button className="mt-4 flex items-center gap-2 bg-white/5 hover:bg-white/10 px-4 py-2 rounded-lg text-sm text-white transition">
          <Bell size={14} /> Set Class Alert
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Materials Checklist */}
        <div className="bg-obsidian-400 p-6 rounded-xl border border-obsidian-500">
          <h2 className="font-bold text-white mb-4">Required Materials</h2>
          <ul className="space-y-3 text-sm text-white/70">
            <li className="flex items-center gap-2"><input type="checkbox" className="accent-cyan" /> Algorithm Design Manual (2nd Ed)</li>
            <li className="flex items-center gap-2"><input type="checkbox" className="accent-cyan" /> Scientific Calculator</li>
          </ul>
          <button className="w-full mt-4 bg-cyan/10 text-cyan py-2 rounded-lg text-xs font-bold uppercase hover:bg-cyan/20">
            Search Campus Catalog
          </button>
        </div>

        {/* NoteMarketplace */}
        <div className="bg-obsidian-400 p-6 rounded-xl border border-obsidian-500">
          <h2 className="font-bold text-white mb-4 flex items-center gap-2">
            <Book size={16} className="text-plug-amber" /> Note Marketplace
          </h2>
          <div className="space-y-3">
            <div className="bg-obsidian-300 p-3 rounded-lg border border-white/5 flex justify-between items-center">
              <div>
                <p className="text-sm font-semibold text-white">Midterm Summary Notes</p>
                <p className="text-xs text-white/40">Uploaded by @David</p>
              </div>
              <span className="text-plug-green font-bold text-sm">₦500</span>
            </div>
            <div className="bg-obsidian-300 p-3 rounded-lg border border-white/5 flex justify-between items-center">
              <div>
                <p className="text-sm font-semibold text-white">Past Questions (2020-2024)</p>
                <p className="text-xs text-white/40">Uploaded by @Sarah</p>
              </div>
              <span className="text-plug-green font-bold text-sm">₦1000</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
