{
  "targets": [
    {
      "target_name": "codegraph_mmap",
      "sources": ["native/mmap_bridge.c"],
      "conditions": [["OS!='mac'", { "type": "none" }]]
    }
  ]
}
