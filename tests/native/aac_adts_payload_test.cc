#include <cassert>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <vector>
namespace base { template<class T> using span=std::span<T>; }
#include "adts-helper.inc"
int main() {
  const std::vector<uint8_t> raw={0xde,2,0,0x4c};
  assert(GetAacPayloadOffset(raw)==0);
  assert(GetAacPayloadOffset(std::vector<uint8_t>{})==0);
  const auto frame=[](bool crc){
    const size_t header=crc?9:7, length=header+4;
    std::vector<uint8_t> v(length,0);
    v[0]=0xff;v[1]=crc?0xf0:0xf1;v[2]=0x4c;v[3]=0x80;
    v[4]=static_cast<uint8_t>(length>>3);v[5]=static_cast<uint8_t>((length&7)<<5|0x1f);v[6]=0xfc;
    v[header]=0xde;v[header+1]=2;return v;
  };
  auto adts=frame(false);assert(GetAacPayloadOffset(adts)==7);
  auto crc=frame(true);assert(GetAacPayloadOffset(crc)==9);
  for(size_t n=2;n<7;++n)assert(!GetAacPayloadOffset(std::span(adts).first(n)));
  auto bad=adts;bad.pop_back();assert(!GetAacPayloadOffset(bad));
  bad=adts;bad.insert(bad.end(),adts.begin(),adts.end());assert(!GetAacPayloadOffset(bad));
  bad=adts;bad[6]|=1;assert(!GetAacPayloadOffset(bad));
  bad=adts;bad[1]|=2;assert(!GetAacPayloadOffset(bad));
  bad=adts;bad[2]=0x7c;assert(!GetAacPayloadOffset(bad));
  bad=adts;bad[4]=0;bad[5]=0xe0;assert(!GetAacPayloadOffset(bad));
  return 0;
}
