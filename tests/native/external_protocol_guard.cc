#include <cassert>
#include <optional>
namespace ui {
enum PageTransition { PAGE_TRANSITION_LINK=0, PAGE_TRANSITION_TYPED=1, PAGE_TRANSITION_RELOAD=8 };
bool PageTransitionCoreTypeIs(PageTransition t, PageTransition core) { return (static_cast<int>(t)&255)==core; }
}
struct Request { int transition_type; };
bool ShouldForward(bool live, bool /*had_initiator_document*/, bool is_primary_main_frame,
                   bool is_in_fenced_frame_tree, std::optional<int> initiating_origin,
                   int transition) {
  const void* initiator_rfh = live ? &live : nullptr;
  Request resource_request{transition};
#include "native_external_protocol_guard.inc"
  return true;
}
int main() {
  assert(ShouldForward(true,true,true,false,1,0)); // live renderer link
  assert(!ShouldForward(false,true,true,false,{},0)); // expired renderer LINK stays blocked
  assert(ShouldForward(false,false,true,false,{},1)); // actual address bar
  assert(ShouldForward(false,false,true,false,{},1|0x20000000)); // typed qualifier
  assert(!ShouldForward(false,false,true,false,{},0)); // no-document LINK
  assert(!ShouldForward(false,false,true,false,{},8)); // reload is not explicit typed
  assert(!ShouldForward(false,false,false,false,{},1)); // no-document subframe
  assert(!ShouldForward(false,false,true,true,{},1)); // fenced frame
  assert(ShouldForward(false,true,true,false,1,1)); // trusted typed redirect with opaque origin
}
