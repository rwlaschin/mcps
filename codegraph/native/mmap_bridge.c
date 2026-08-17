#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

typedef struct { int fd; } mmap_handle;
typedef struct { void *address; size_t length; int mapped; } mmap_mapping;

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

static void finalize_handle(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  mmap_handle *handle = data;
  if (handle->fd >= 0) close(handle->fd);
  free(handle);
}

static void finalize_mapping(napi_env env, void *data, void *hint) {
  (void)env; (void)data;
  mmap_mapping *mapping = hint;
  if (mapping->mapped) munmap(mapping->address, mapping->length);
  free(mapping);
}

static mmap_handle *get_handle(napi_env env, napi_value value) {
  mmap_handle *handle = NULL;
  if (napi_get_value_external(env, value, (void **)&handle) != napi_ok || handle == NULL || handle->fd < 0) {
    napi_throw_error(env, NULL, "invalid or closed mmap handle");
    return NULL;
  }
  return handle;
}

static napi_value open_file(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) return fail(env, "open requires path and capacity");
  size_t length = 0;
  napi_get_value_string_utf8(env, argv[0], NULL, 0, &length);
  char *path = malloc(length + 1);
  if (!path) return fail(env, "mmap path allocation failed");
  napi_get_value_string_utf8(env, argv[0], path, length + 1, &length);
  int fd = open(path, O_RDWR | O_CREAT, 0600);
  free(path);
  if (fd < 0) return fail(env, strerror(errno));
  uint32_t capacity;
  struct stat statbuf;
  if (napi_get_value_uint32(env, argv[1], &capacity) != napi_ok || capacity == 0) { close(fd); return fail(env, "invalid mmap capacity"); }
  if (fstat(fd, &statbuf) != 0) { int saved = errno; close(fd); return fail(env, strerror(saved)); }
  if (statbuf.st_size < (off_t)capacity && ftruncate(fd, (off_t)capacity) != 0) { int saved = errno; close(fd); return fail(env, strerror(saved)); }
  mmap_handle *handle = malloc(sizeof(*handle));
  if (!handle) { close(fd); return fail(env, "mmap handle allocation failed"); }
  handle->fd = fd;
  napi_value result;
  napi_create_external(env, handle, finalize_handle, NULL, &result);
  return result;
}

static napi_value resize_file(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; uint32_t capacity;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) return fail(env, "resize requires handle and capacity");
  mmap_handle *handle = get_handle(env, argv[0]);
  if (!handle) return NULL;
  if (napi_get_value_uint32(env, argv[1], &capacity) != napi_ok || capacity == 0) return fail(env, "invalid mmap capacity");
  if (ftruncate(handle->fd, (off_t)capacity) != 0) return fail(env, strerror(errno));
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value map_file(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; struct stat statbuf;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return fail(env, "map requires handle");
  mmap_handle *handle = get_handle(env, argv[0]);
  if (!handle) return NULL;
  if (fstat(handle->fd, &statbuf) != 0 || statbuf.st_size <= 0) return fail(env, "invalid mmap file size");
  void *address = mmap(NULL, (size_t)statbuf.st_size, PROT_READ | PROT_WRITE, MAP_SHARED, handle->fd, 0);
  if (address == MAP_FAILED) return fail(env, strerror(errno));
  mmap_mapping *mapping = malloc(sizeof(*mapping));
  if (!mapping) { munmap(address, (size_t)statbuf.st_size); return fail(env, "mmap state allocation failed"); }
  mapping->address = address; mapping->length = (size_t)statbuf.st_size; mapping->mapped = 1;
  napi_value arraybuffer, typedarray, state;
  if (napi_create_external_arraybuffer(env, address, mapping->length, finalize_mapping, mapping, &arraybuffer) != napi_ok) {
    munmap(address, mapping->length); free(mapping);
    return fail(env, "failed to expose mmap mapping");
  }
  if (napi_create_typedarray(env, napi_uint8_array, mapping->length, arraybuffer, 0, &typedarray) != napi_ok) {
    munmap(address, mapping->length); mapping->mapped = 0;
    return fail(env, "failed to create mmap typed array");
  }
  napi_create_external(env, mapping, NULL, NULL, &state);
  napi_set_named_property(env, typedarray, "__mmapState", state);
  return typedarray;
}

static int get_mapping(napi_env env, napi_value value, void **data, size_t *length, napi_value *arraybuffer) {
  napi_typedarray_type type; size_t count; size_t offset;
  if (napi_get_typedarray_info(env, value, &type, &count, data, arraybuffer, &offset) != napi_ok || type != napi_uint8_array || offset != 0) {
    napi_throw_error(env, NULL, "invalid mmap mapping"); return 0;
  }
  *length = count;
  return 1;
}

static napi_value flush_mapping(napi_env env, napi_callback_info info) {
  size_t argc = 3, length; napi_value argv[3], arraybuffer; void *data;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 3 || !get_mapping(env, argv[0], &data, &length, &arraybuffer)) return NULL;
  uint32_t requested_offset, requested_length;
  if (napi_get_value_uint32(env, argv[1], &requested_offset) != napi_ok ||
      napi_get_value_uint32(env, argv[2], &requested_length) != napi_ok || requested_length == 0 ||
      (size_t)requested_offset > length || (size_t)requested_length > length - (size_t)requested_offset) {
    return fail(env, "invalid mmap flush range");
  }
  long page_value = sysconf(_SC_PAGESIZE);
  if (page_value <= 0) return fail(env, "sysconf(_SC_PAGESIZE) failed");
  size_t page = (size_t)page_value;
  size_t offset = (size_t)requested_offset;
  size_t end = offset + (size_t)requested_length;
  offset -= offset % page;
  size_t aligned_end = end + ((page - (end % page)) % page);
  if (aligned_end > length) aligned_end = length;
  size_t aligned_length = aligned_end - offset;
  if (msync((char *)data + offset, aligned_length, MS_SYNC) != 0) return fail(env, strerror(errno));
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value unmap_mapping(napi_env env, napi_callback_info info) {
  size_t argc = 1, length; napi_value argv[1], arraybuffer, state; void *data; mmap_mapping *mapping = NULL;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return fail(env, "unmap requires mapping");
  if (!get_mapping(env, argv[0], &data, &length, &arraybuffer)) return NULL;
  if (napi_get_named_property(env, argv[0], "__mmapState", &state) != napi_ok || napi_get_value_external(env, state, (void **)&mapping) != napi_ok || !mapping) return fail(env, "missing mmap state");
  if (mapping->mapped) {
    if (munmap(mapping->address, mapping->length) != 0) return fail(env, strerror(errno));
    mapping->mapped = 0;
  }
  if (napi_detach_arraybuffer(env, arraybuffer) != napi_ok) return fail(env, "failed to detach mmap ArrayBuffer");
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value close_file(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return fail(env, "close requires handle");
  mmap_handle *handle = NULL;
  if (napi_get_value_external(env, argv[0], (void **)&handle) != napi_ok || !handle) return fail(env, "invalid mmap handle");
  if (handle->fd >= 0) { if (close(handle->fd) != 0) return fail(env, strerror(errno)); handle->fd = -1; }
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value page_size(napi_env env, napi_callback_info info) {
  (void)info; long value = sysconf(_SC_PAGESIZE);
  if (value <= 0) return fail(env, "sysconf(_SC_PAGESIZE) failed");
  napi_value result; napi_create_int64(env, value, &result); return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "open", NULL, open_file, NULL, NULL, NULL, napi_default, NULL },
    { "resize", NULL, resize_file, NULL, NULL, NULL, napi_default, NULL },
    { "map", NULL, map_file, NULL, NULL, NULL, napi_default, NULL },
    { "flush", NULL, flush_mapping, NULL, NULL, NULL, napi_default, NULL },
    { "unmap", NULL, unmap_mapping, NULL, NULL, NULL, napi_default, NULL },
    { "close", NULL, close_file, NULL, NULL, NULL, napi_default, NULL },
    { "pageSize", NULL, page_size, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
